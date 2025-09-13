/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

// Simple Chip Assistant Provider
class AITerminalProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "aiTerminalView";
	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri) {}

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

		webviewView.webview.html = this._getAITerminalHtml();

		// Handle messages from webview
		webviewView.webview.onDidReceiveMessage(
			(message) => {
				switch (message.command) {
					case "sendCommand":
						this._handleAICommand(message.text);
						break;
				}
			},
			undefined,
			[],
		);
	}

	private _handleAICommand(command: string) {
		// Simple AI responses for now
		let response = "";

		if (
			command.toLowerCase().includes("hello") ||
			command.toLowerCase().includes("hi")
		) {
			response =
				"AI: Hello! I'm your verification assistant. Ask me about RTL, testbenches, or verification!";
		} else if (command.toLowerCase().includes("help")) {
			response =
				"AI: I can help with:\n- RTL code analysis\n- Testbench generation\n- Verification strategies\n- SystemVerilog questions";
		} else if (
			command.toLowerCase().includes("rtl") ||
			command.toLowerCase().includes("verilog")
		) {
			response =
				"AI: Great! I can help with RTL design. What specific aspect would you like help with?";
		} else if (command.toLowerCase().includes("test")) {
			response =
				"AI: Testing is crucial! Are you working on unit tests, integration tests, or verification testbenches?";
		} else {
			response = `AI: You said "${command}". I'm a simple AI assistant - ask me about verification, RTL, or testbenches!`;
		}

		if (this._view) {
			this._view.webview.postMessage({
				command: "addResponse",
				text: response,
			});
		}
	}

	private _getAITerminalHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Chip Assistant</title>
	<style>
		body { 
			font-family: 'Courier New', monospace;
			padding: 0;
			margin: 0;
			background: var(--vscode-terminal-background, #1e1e1e);
			color: var(--vscode-terminal-foreground, #cccccc);
			height: 100vh;
			display: flex;
			flex-direction: column;
		}
		.terminal-container {
			flex: 1;
			overflow-y: auto;
			padding: 10px;
			font-size: 14px;
			line-height: 1.4;
		}
		.terminal-line {
			margin: 2px 0;
			white-space: pre-wrap;
			word-wrap: break-word;
		}
		.user-input {
			color: var(--vscode-terminal-ansiGreen, #00ff00);
		}
		.ai-response {
			color: var(--vscode-terminal-ansiCyan, #00ffff);
			margin-left: 0;
		}
		.prompt {
			color: var(--vscode-terminal-ansiYellow, #ffff00);
		}
		.input-container {
			display: flex;
			padding: 8px;
			background: var(--vscode-input-background);
			border-top: 1px solid var(--vscode-panel-border);
		}
		.prompt-symbol {
			color: var(--vscode-terminal-ansiYellow, #ffff00);
			margin-right: 5px;
			user-select: none;
		}
		input {
			flex: 1;
			background: transparent;
			border: none;
			color: var(--vscode-terminal-foreground, #cccccc);
			font-family: 'Courier New', monospace;
			font-size: 14px;
			outline: none;
		}
		.welcome {
			color: var(--vscode-terminal-ansiBlue, #0000ff);
			margin-bottom: 10px;
		}
	</style>
</head>
<body>
	<div class="terminal-container" id="terminalContainer">
		<div class="terminal-line welcome">AI Verification Terminal v0.0</div>
		<div class="terminal-line welcome">Type 'help' for available commands</div>
		<div class="terminal-line welcome">---</div>
	</div>
	<div class="input-container">
		<span class="prompt-symbol">ai$</span>
		<input type="text" id="commandInput" placeholder="Enter command..." />
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		
		function sendCommand() {
			const input = document.getElementById('commandInput');
			const command = input.value.trim();
			if (command) {
				// Show user input
				addTerminalLine('ai$ ' + command, 'user-input');
				
				// Send to extension
				vscode.postMessage({ command: 'sendCommand', text: command });
				input.value = '';
			}
		}
		
		function addTerminalLine(text, className = '') {
			const container = document.getElementById('terminalContainer');
			const line = document.createElement('div');
			line.className = 'terminal-line ' + className;
			line.textContent = text;
			container.appendChild(line);
			container.scrollTop = container.scrollHeight;
		}
		
		// Handle messages from extension
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.command === 'addResponse') {
				// Add AI response with proper line breaks
				const lines = message.text.split('\\n');
				lines.forEach(line => {
					addTerminalLine(line, 'ai-response');
				});
			}
		});
		
		// Send command on Enter key
		document.getElementById('commandInput').addEventListener('keypress', function(e) {
			if (e.key === 'Enter') {
				sendCommand();
			}
		});
		
		// Focus on input when terminal is clicked
		document.getElementById('terminalContainer').addEventListener('click', function() {
			document.getElementById('commandInput').focus();
		});
		
		// Auto-focus on load
		document.getElementById('commandInput').focus();
	</script>
</body>
</html>`;
	}
}

// Main extension activation
export function activate(context: vscode.ExtensionContext) {
	console.log("Chip Assistant extension is now active!");

	// Register the Chip Assistant provider
	const aiTerminalProvider = new AITerminalProvider(context.extensionUri);

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

	context.subscriptions.push(showAITerminal);
}

export function deactivate() {}
