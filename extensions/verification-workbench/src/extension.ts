/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// +----------------+      User Input       +----------------+
// |                |  ----------------->  |                |
// |  VSCode Editor |                       |  Webview Panel |
// |  (extension.js)|  <-----------------  |  (chat UI)     |
// +----------------+      AI Response     +----------------+
//         ^                                     |
//         |                                     |
//         |                                     v
//         |                             +----------------+
//         |                             |                |
//         |                             |  Extension     |
//         |                             |  _handleChat   |
//         |                             |  _postMessage  |
//         |                             +----------------+
//         |                                     |
//         |                                     v
//         |                             +----------------+
//         |                             |                |
//         |                             |  OpenAI API    |
//         |                             |  (o3-mini)     |
//         |                             +----------------+
//         |
//         +-----------------------------------------+
//                    Commands: set/clear API key


import * as vscode from "vscode";
import { fetch } from "undici";

// Simple Chip Assistant Provider
class AITerminalProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "aiTerminalView";
	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getChatHtml();

		// Handle messages from webview
		webviewView.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case "chat:send": {
						const text: string = message.text ?? "";
						await this._handleChatMessage(text);
						break;
					}
					case "chat:getConfig": {
						const config = vscode.workspace.getConfiguration();
						const model = config.get<string>("chipAssistant.openai.model", "o3-mini");
						const baseUrl = config.get<string>("chipAssistant.openai.baseUrl", "https://api.openai.com/v1");
						const apiKey = await this._context.secrets.get("chipAssistant.openai.apiKey");
						this._postMessage({ command: "chat:config", payload: { hasKey: Boolean(apiKey), model, baseUrl } });
						break;
					}
				}
			},
			undefined,
			[],
		);
	}

	private async _handleChatMessage(userText: string) {
		if (!userText.trim()) {
			return;
		}
		this._postMessage({ command: "chat:userEcho", payload: { text: userText } });

		try {
			const config = vscode.workspace.getConfiguration();
			const model = config.get<string>("chipAssistant.openai.model", "o3-mini");
			const baseUrl = config.get<string>("chipAssistant.openai.baseUrl", "https://api.openai.com/v1");
			const timeoutMs = config.get<number>("chipAssistant.request.timeoutMs", 60000);
			const apiKey = await this._context.secrets.get("chipAssistant.openai.apiKey");

			if (!apiKey) {
				this._postMessage({ command: "chat:error", payload: { message: "OpenAI API key not set. Run 'Chip Assistant: Set OpenAI API Key'." } });
				return;
			}

			const controller = new AbortController();
			const t = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

			let assistantText: string | undefined;
			try {
				const resp = await fetch(`${baseUrl}/responses`, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model,
						input: [
							{
								role: "user",
								content: [{ type: "text", text: userText }],
							},
						],
					}),
					signal: controller.signal,
				});
				if (resp.ok) {
					const data: any = await resp.json();
					assistantText = AITerminalProvider._extractTextFromResponses(data);
				}
			} catch (_err) {
				// fallback
			} finally {
				clearTimeout(t);
			}

			if (!assistantText) {
				const controller2 = new AbortController();
				const t2 = setTimeout(() => controller2.abort(), Math.max(1000, timeoutMs));
				try {
					const resp2 = await fetch(`${baseUrl}/chat/completions`, {
						method: "POST",
						headers: {
							"Authorization": `Bearer ${apiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							model: model === "o3-mini" ? "gpt-4o-mini" : model,
							messages: [
								{ role: "system", content: "You are Chip Assistant, a helpful verification assistant for RTL, testbenches, and SystemVerilog." },
								{ role: "user", content: userText },
							],
							temperature: 0.2,
						}),
						signal: controller2.signal,
					});
					if (!resp2.ok) {
						const errText = await resp2.text();
						throw new Error(`OpenAI error ${resp2.status}: ${errText}`);
					}
					const data2: any = await resp2.json();
					assistantText = data2?.choices?.[0]?.message?.content ?? "";
				} finally {
					clearTimeout(t2);
				}
			}

			this._postMessage({ command: "chat:assistant", payload: { text: assistantText ?? "" } });
		} catch (err: any) {
			const message = err?.message ?? String(err);
			this._postMessage({ command: "chat:error", payload: { message } });
		}
	}

	private _postMessage(msg: any) {
		if (this._view) {
			this._view.webview.postMessage(msg);
		}
	}

	private static _extractTextFromResponses(obj: any): string {
		try {
			const output = obj?.output ?? obj?.response ?? obj;
			const first = Array.isArray(output)?.valueOf() ? output[0] : (output?.[0] ?? output);
			const content = first?.content ?? obj?.content ?? [];
			const parts = Array.isArray(content) ? content : [];
			const text = parts.map((p: any) => p?.text ?? p?.content ?? "").filter(Boolean).join("\n");
			return text || JSON.stringify(obj);
		} catch {
			return "";
		}
	}

	private _getChatHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Chip Assistant</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			padding: 0;
			margin: 0;
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			height: 100vh;
			display: flex;
			flex-direction: column;
		}
		.header { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
		.chat-container { flex: 1; overflow-y: auto; padding: 12px; font-size: 13px; line-height: 1.4; }
		.msg { margin: 8px 0; display: flex; }
		.msg .bubble { max-width: 85%; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
		.msg.user { justify-content: flex-end; }
		.msg.user .bubble { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); }
		.msg.assistant .bubble { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
		.footer { display: flex; gap: 8px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
		textarea { flex: 1; resize: none; max-height: 120px; min-height: 38px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 8px; font-family: var(--vscode-font-family); }
		button { padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 6px; cursor: pointer; }
	</style>
</head>
<body>
	<div class="header">Chip Assistant</div>
	<div class="chat-container" id="chatContainer"></div>
	<div class="footer">
		<textarea id="promptInput" placeholder="Ask about RTL, testbenches, SystemVerilog..."></textarea>
		<button id="sendBtn">Send</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		function addMessage(role, text) {
			const container = document.getElementById('chatContainer');
			const row = document.createElement('div');
			row.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
			const bubble = document.createElement('div');
			bubble.className = 'bubble';
			bubble.textContent = text;
			row.appendChild(bubble);
			container.appendChild(row);
			container.scrollTop = container.scrollHeight;
		}

		function sendPrompt() {
			const input = document.getElementById('promptInput');
			const text = input.value.trim();
			if (!text) return;
			addMessage('user', text);
			vscode.postMessage({ command: 'chat:send', text });
			input.value = '';
		}

		// Handle messages from extension
		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.command) {
				case 'chat:assistant': {
					addMessage('assistant', message.payload?.text || '');
					break;
				}
				case 'chat:error': {
					addMessage('assistant', 'Error: ' + (message.payload?.message || 'Unknown error'));
					break;
				}
				case 'chat:config': {
					break;
				}
				case 'chat:userEcho': {
					break;
				}
			}
		});

		document.getElementById('sendBtn').addEventListener('click', sendPrompt);
		document.getElementById('promptInput').addEventListener('keypress', function(e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendPrompt();
			}
		});
		vscode.postMessage({ command: 'chat:getConfig' });
	</script>
</body>
</html>`;
	}
}

// Main extension activation
export function activate(context: vscode.ExtensionContext) {
	console.log("Chip Assistant extension is now active!");

	// Register the Chip Assistant provider
	const aiTerminalProvider = new AITerminalProvider(context.extensionUri, context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			AITerminalProvider.viewType,
			aiTerminalProvider,
		),
	);

	// Simple command to show the Chip Assistant
	const showAITerminal = vscode.commands.registerCommand(
		"aiTerminal.show",
		() => {
			vscode.commands.executeCommand("aiTerminalView.focus");
			vscode.window.showInformationMessage("Chip Assistant activated!");
		},
	);

	const setKey = vscode.commands.registerCommand("chipAssistant.setApiKey", async () => {
		const value = await vscode.window.showInputBox({ prompt: "Enter OpenAI API Key", placeHolder: "sk-...", password: true, ignoreFocusOut: true });
		if (value) {
			await context.secrets.store("chipAssistant.openai.apiKey", value.trim());
			vscode.window.showInformationMessage("Chip Assistant: API key saved.");
		}
	});

	const clearKey = vscode.commands.registerCommand("chipAssistant.clearApiKey", async () => {
		await context.secrets.delete("chipAssistant.openai.apiKey");
		vscode.window.showInformationMessage("Chip Assistant: API key cleared.");
	});

	context.subscriptions.push(showAITerminal, setKey, clearKey);
}

export function deactivate() { }
