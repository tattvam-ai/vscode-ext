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
import { OpenroadConfigPanel } from "./openroadConfigPanel";
import { OpenroadRunner } from "./openroadRunner";
import { OpenroadSidebar } from "./openroadSidebar";
// import { OpenroadResultsSidebar } from "./openroadResultsSidebar";

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
		this._postMessage({ command: "chat:typing", payload: { on: true } });

		try {
			const config = vscode.workspace.getConfiguration();
			const model = config.get<string>("chipAssistant.openai.model", "o3-mini");
			const baseUrl = config.get<string>("chipAssistant.openai.baseUrl", "https://api.openai.com/v1");
			const timeoutMs = config.get<number>("chipAssistant.request.timeoutMs", 60000);
			const apiKey = await this._context.secrets.get("chipAssistant.openai.apiKey");
			// Encourage model to format SystemVerilog with proper fenced blocks
			const formattingHint = "\n\nWhen you include code, use fenced triple backticks with language systemverilog (```systemverilog). Show code first, then concise bullet notes.";
			const effectiveUser = `${userText}${formattingHint}`;

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
								content: [{ type: "text", text: effectiveUser }],
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
								{ role: "system", content: "You are Chip Assistant, a helpful verification assistant for RTL, testbenches, and SystemVerilog. When you include code, always use fenced triple backticks with language systemverilog (```systemverilog). Show code first, then concise bullet notes." },
								{ role: "user", content: effectiveUser },
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
		finally {
			this._postMessage({ command: "chat:typing", payload: { on: false } });
		}
	}

	private _postMessage(msg: any) {
		if (this._view) {
			this._view.webview.postMessage(msg);
		}
	}

	public async askWithIntent(intentLabel: string, selectedText: string) {
		const prompt = `${intentLabel}:\n\n${selectedText}`;
		await vscode.commands.executeCommand("aiTerminalView.focus");
		await this._handleChatMessage(prompt);
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
		/* basic markdown styling */
		.msg.assistant .bubble h1, .msg.assistant .bubble h2, .msg.assistant .bubble h3 { margin: 6px 0 4px; font-weight: 600; }
		.msg.assistant .bubble ul { padding-left: 16px; margin: 4px 0; }
		.msg.assistant .bubble li { margin: 2px 0; }
		.msg.assistant .bubble code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 0 3px; border-radius: 3px; }
		.msg.assistant .bubble pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 8px; border-radius: 6px; overflow-x: auto; }
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
			bubble.textContent = String(text || '');
			row.appendChild(bubble);
			container.appendChild(row);
			container.scrollTop = container.scrollHeight;
		}

		let typingEl = null;
		function setTyping(on) {
			const container = document.getElementById('chatContainer');
			if (on) {
				if (typingEl) return;
				typingEl = document.createElement('div');
				typingEl.className = 'msg assistant';
				const b = document.createElement('div');
				b.className = 'bubble';
				b.textContent = 'Thinking…';
				typingEl.appendChild(b);
				container.appendChild(typingEl);
				container.scrollTop = container.scrollHeight;
			} else if (typingEl) {
				typingEl.remove();
				typingEl = null;
			}
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
				case 'chat:typing': {
					setTyping(Boolean(message.payload?.on));
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
		document.getElementById('promptInput').addEventListener('keypress', function (e) {
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

class SelectionIntentCodeLensProvider implements vscode.CodeLensProvider {
	private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

	private _activeSelection: { documentUri: string; range: vscode.Range } | null = null;

	public setActiveSelection(document: vscode.TextDocument, range: vscode.Range) {
		this._activeSelection = { documentUri: document.uri.toString(), range };
		this._onDidChangeCodeLenses.fire();
	}

	public clear() {
		this._activeSelection = null;
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
		if (!this._activeSelection || this._activeSelection.documentUri !== document.uri.toString()) {
			return [];
		}
		const line = this._activeSelection.range.start.line;
		const pos = new vscode.Position(Math.max(0, line), 0);
		const range = new vscode.Range(pos, pos);

		const items: { title: string; command: string }[] = [
			{ title: "Explain", command: "chipAssistant.explainSelection" },
			{ title: "Find Bugs", command: "chipAssistant.findBugsSelection" },
			{ title: "SV Assertions", command: "chipAssistant.assertionsSelection" },
			{ title: "Optimize", command: "chipAssistant.optimizeSelection" },
		];

		return items.map(it => new vscode.CodeLens(range, { title: it.title, command: it.command }));
	}
}

// Main extension activation
export function activate(context: vscode.ExtensionContext) {
	console.log("Chip Assistant extension is now active!");

	// Register the Chip Assistant provider
	const aiTerminalProvider = new AITerminalProvider(context.extensionUri, context);

	// OpenROAD status bar item (Run/Stop)
	const openroadStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	openroadStatusItem.name = "OpenROAD Flow";
	context.subscriptions.push(openroadStatusItem);

	// OpenROAD actions status bar item (ellipsis opens actions)
	const openroadActionsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	openroadActionsItem.name = "OpenROAD Actions";
	openroadActionsItem.text = "$(kebab-vertical)";
	openroadActionsItem.tooltip = "OpenROAD actions (Run/Stop, Clean All, Configure)";
	openroadActionsItem.command = "openroad.actions";
	openroadActionsItem.show();
	context.subscriptions.push(openroadActionsItem);

	function updateOpenroadStatusItem() {
		const running = OpenroadRunner.getInstance().isRunning();
		openroadStatusItem.text = running ? "$(debug-stop) OpenROAD Stop" : "$(play) OpenROAD Run";
		openroadStatusItem.command = running ? "openroad.stopFlow" : "openroad.runFlow";
		openroadStatusItem.tooltip = running ? "Stop OpenROAD flow (Right-click for actions)" : "Run OpenROAD flow (Right-click for actions)";
		openroadStatusItem.show();
	}
	updateOpenroadStatusItem();
	const statusTimer = setInterval(updateOpenroadStatusItem, 1000);
	context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

	// OpenROAD: Show GUI (gui_final)
	const guiFinal = vscode.commands.registerCommand("openroad.guiFinal", async () => {
		const runner = OpenroadRunner.getInstance();
		await runner.guiFinal();
		updateOpenroadStatusItem();
	});

	const openroadActions = vscode.commands.registerCommand("openroad.actions", async () => {
		const running = OpenroadRunner.getInstance().isRunning();
		const picks: Array<{ label: string; action: () => Promise<void> | void }> = [
			{ label: running ? "Stop Flow" : "Run Flow", action: async () => running ? vscode.commands.executeCommand("openroad.stopFlow") : vscode.commands.executeCommand("openroad.runFlow") },
			{ label: "Clean All", action: async () => vscode.commands.executeCommand("openroad.cleanAll") },
			{ label: "Show GUI (gui_final)", action: async () => vscode.commands.executeCommand("openroad.guiFinal") },
			{ label: "Configure Flow", action: async () => vscode.commands.executeCommand("openroad.configureFlow") },
		];
		const choice = await vscode.window.showQuickPick(picks.map(p => p.label), { placeHolder: "OpenROAD actions" });
		const picked = picks.find(p => p.label === choice);
		if (picked) {
			await picked.action();
			updateOpenroadStatusItem();
		}
	});
	context.subscriptions.push(openroadActions);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			AITerminalProvider.viewType,
			aiTerminalProvider,
		),
	);

	const openroadSidebarProvider = new OpenroadSidebar(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			OpenroadSidebar.viewType,
			openroadSidebarProvider,
		),
	);

	// Results sidebar removed
	// const resultsSidebarProvider = new OpenroadResultsSidebar(context.extensionUri);
	// context.subscriptions.push(
	// 	vscode.window.registerWebviewViewProvider(
	// 		OpenroadResultsSidebar.viewType,
	// 		resultsSidebarProvider,
	// 	),
	// );

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

	// OpenROAD: Set FLOW_HOME
	const setFlowHome = vscode.commands.registerCommand("openroad.setFlowHome", async () => {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			canSelectFiles: false,
			canSelectFolders: true,
			title: "Select OpenROAD-flow-scripts root (FLOW_HOME)",
			openLabel: "Use as FLOW_HOME",
		});
		if (!picked || picked.length === 0) {
			return;
		}
		const flowHome = picked[0].fsPath;
		await vscode.workspace.getConfiguration().update(
			"openroad.flow.flowHome",
			flowHome,
			vscode.ConfigurationTarget.Workspace
		);
		vscode.window.showInformationMessage(`OpenROAD FLOW_HOME set to: ${flowHome}`);
	});

	// OpenROAD: Configure Flow (wizard)
	const configureFlow = vscode.commands.registerCommand("openroad.configureFlow", async () => {
		await OpenroadConfigPanel.createOrShow(context);
	});

	// OpenROAD: Run Flow
	const runFlow = vscode.commands.registerCommand("openroad.runFlow", async () => {
		const runner = OpenroadRunner.getInstance();
		await runner.runFlow();
		updateOpenroadStatusItem();
	});

	// OpenROAD: Stop Flow
	const stopFlow = vscode.commands.registerCommand("openroad.stopFlow", async () => {
		const runner = OpenroadRunner.getInstance();
		runner.stopFlow();
		updateOpenroadStatusItem();
	});

	// OpenROAD: Clean All
	const cleanAll = vscode.commands.registerCommand("openroad.cleanAll", async () => {
		const runner = OpenroadRunner.getInstance();
		await runner.cleanAll();
		updateOpenroadStatusItem();
	});

	function registerSelectionIntent(command: string, intentLabel: string) {
		return vscode.commands.registerCommand(command, async () => {
			const editor = vscode.window.activeTextEditor;
			const selection = editor?.selection;
			if (!editor || !selection || selection.isEmpty) {
				vscode.window.showInformationMessage("Select some text first.");
				return;
			}
			const selected = editor.document.getText(selection);
			await aiTerminalProvider.askWithIntent(intentLabel, selected);
		});
	}

	const explainCmd = registerSelectionIntent(
		"chipAssistant.explainSelection",
		"Explain the following code",
	);
	const bugsCmd = registerSelectionIntent(
		"chipAssistant.findBugsSelection",
		"Find potential bugs in the following code",
	);
	const svaCmd = registerSelectionIntent(
		"chipAssistant.assertionsSelection",
		"Generate SystemVerilog assertions for the following code",
	);
	const optCmd = registerSelectionIntent(
		"chipAssistant.optimizeSelection",
		"Optimize the following code",
	);

	// OpenROAD: Show Results Panel
	// const showResults = vscode.commands.registerCommand("openroad.showResults", async () => {
	// 	await OpenroadResultsPanel.show(context);
	// });

	context.subscriptions.push(
		showAITerminal,
		setKey,
		clearKey,
		setFlowHome,
		configureFlow,
		runFlow,
		stopFlow,
		cleanAll,
		guiFinal,
		explainCmd,
		bugsCmd,
		svaCmd,
		optCmd,
	);

	// Register inline CodeLens for selection intents
	const lensProvider = new SelectionIntentCodeLensProvider();
	const lensSelector: vscode.DocumentSelector = [{ scheme: "file" }, { scheme: "untitled" }];
	const lensRegistration = vscode.languages.registerCodeLensProvider(lensSelector, lensProvider);
	const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
		const editor = e.textEditor;
		if (!editor || e.selections.length === 0 || e.selections[0].isEmpty) {
			lensProvider.clear();
			return;
		}
		lensProvider.setActiveSelection(editor.document, e.selections[0]);
	});
	context.subscriptions.push(lensRegistration, selectionListener);
}

export function deactivate() { }
