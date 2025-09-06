/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

// AI Chat Panel Provider for bottom panel
class AIChatProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "aiChatView";
	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(webviewView: vscode.WebviewView) {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml();
		this.handleMessages(webviewView);
	}

	private handleMessages(webviewView: vscode.WebviewView) {
		webviewView.webview.onDidReceiveMessage((message) => {
			if (message.command === "sendMessage") {
				this.handleAIMessage(message.text);
			}
		});
	}

	private handleAIMessage(message: string) {
		if (this._view) {
			this._view.webview.postMessage({
				command: "addMessage",
				text: `AI: Processing "${message}" - RTL analysis coming soon!`,
				sender: "ai",
			});
		}
	}

	private getHtml(): string {
		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		body { font-family: var(--vscode-font-family); padding: 10px; background: var(--vscode-editor-background); }
		.chat { height: 200px; overflow-y: scroll; border: 1px solid var(--vscode-panel-border); padding: 8px; margin-bottom: 8px; }
		.message { margin: 4px 0; padding: 6px; border-radius: 4px; }
		.user { background: var(--vscode-button-background); text-align: right; }
		.ai { background: var(--vscode-inputOption-activeBackground); }
		.input-row { display: flex; gap: 8px; }
		input { flex: 1; padding: 6px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
		button { padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
	</style>
</head>
<body>
	<div class="chat" id="chat">
		<div class="message ai">AI Assistant ready for RTL verification tasks!</div>
	</div>
	<div class="input-row">
		<input type="text" id="input" placeholder="Ask about your RTL code..." />
		<button onclick="send()">Send</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		function send() {
			const input = document.getElementById("input");
			const msg = input.value.trim();
			if (msg) {
				addMsg(msg, "user");
				vscode.postMessage({ command: "sendMessage", text: msg });
				input.value = "";
			}
		}
		function addMsg(text, sender) {
			const chat = document.getElementById("chat");
			const div = document.createElement("div");
			div.className = "message " + sender;
			div.textContent = text;
			chat.appendChild(div);
			chat.scrollTop = chat.scrollHeight;
		}
		window.addEventListener("message", event => {
			if (event.data.command === "addMessage") {
				addMsg(event.data.text, event.data.sender);
			}
		});
		document.getElementById("input").addEventListener("keypress", e => {
			if (e.key === "Enter") send();
		});
	</script>
</body>
</html>`;
	}
}

// Verification Workbench Provider for center editor area
class VerificationWorkbenchProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "verificationWorkbench";

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(webviewView: vscode.WebviewView) {
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml();
	}

	private getHtml(): string {
		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		body { font-family: var(--vscode-font-family); padding: 20px; background: var(--vscode-editor-background); text-align: center; }
		.workbench { border: 2px dashed var(--vscode-panel-border); padding: 40px; border-radius: 8px; }
		.title { font-size: 24px; margin-bottom: 16px; color: var(--vscode-foreground); }
		.subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 24px; }
		.features { text-align: left; display: inline-block; }
		.feature { margin: 8px 0; color: var(--vscode-foreground); }
	</style>
</head>
<body>
	<div class="workbench">
		<div class="title">Verification Workbench</div>
		<div class="subtitle">RTL Code Editor & Analysis Center</div>
		<div class="features">
			<div class="feature">• SystemVerilog syntax highlighting</div>
			<div class="feature">• Testbench integration</div>
			<div class="feature">• Coverage analysis</div>
			<div class="feature">• AI-powered verification</div>
		</div>
		<p style="margin-top: 24px; color: var(--vscode-descriptionForeground);">
			Open RTL files to begin verification workflow
		</p>
	</div>
</body>
</html>`;
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Register AI Chat in bottom panel
	const aiChatProvider = new AIChatProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			AIChatProvider.viewType,
			aiChatProvider,
		),
	);

	// Register Verification Workbench
	const workbenchProvider = new VerificationWorkbenchProvider(
		context.extensionUri,
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			VerificationWorkbenchProvider.viewType,
			workbenchProvider,
		),
	);

	// Register toggle command
	const toggleCommand = vscode.commands.registerCommand(
		"verificationWorkbench.toggle",
		() => {
			vscode.commands.executeCommand("aiChatView.focus");
			vscode.window.showInformationMessage("Verification Workbench activated!");
		},
	);

	context.subscriptions.push(toggleCommand);

	// Auto-focus AI chat panel on startup
	setTimeout(() => {
		vscode.commands.executeCommand("aiChatView.focus");
	}, 1000);
}

export function deactivate() {}

