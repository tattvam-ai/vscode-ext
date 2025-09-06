/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// AI Chat Panel Provider
class AIChatProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'aiChatView';
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
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.html = this._getAIChatHtml();

		// Handle messages from webview
		webviewView.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'sendMessage':
						this._handleAIMessage(message.text);
						break;
				}
			},
			undefined,
			[]
		);
	}

	private _handleAIMessage(message: string) {
		// For now, just echo back - later integrate with AI service
		if (this._view) {
			this._view.webview.postMessage({
				command: 'addMessage',
				text: `AI: You said "${message}". This is where AI integration will go!`,
				sender: 'ai'
			});
		}
	}

	private _getAIChatHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>AI Assistant</title>
	<style>
		body { 
			font-family: var(--vscode-font-family);
			padding: 10px;
			background: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
		}
		.chat-container { 
			height: 300px; 
			overflow-y: scroll; 
			border: 1px solid var(--vscode-panel-border);
			padding: 10px;
			margin-bottom: 10px;
			background: var(--vscode-input-background);
		}
		.message { 
			margin: 5px 0; 
			padding: 8px;
			border-radius: 4px;
		}
		.user-message { 
			background: var(--vscode-button-background);
			text-align: right;
		}
		.ai-message { 
			background: var(--vscode-inputOption-activeBackground);
		}
		.input-container { 
			display: flex; 
			gap: 5px;
		}
		input { 
			flex: 1; 
			padding: 8px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px;
		}
		button { 
			padding: 8px 12px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 2px;
			cursor: pointer;
		}
		button:hover { 
			background: var(--vscode-button-hoverBackground);
		}
	</style>
</head>
<body>
	<div class="chat-container" id="chatContainer">
		<div class="message ai-message">AI Assistant ready! Ask about your RTL code, testbenches, or verification strategies.</div>
	</div>
	<div class="input-container">
		<input type="text" id="messageInput" placeholder="Ask AI about your verification..." />
		<button onclick="sendMessage()">Send</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		
		function sendMessage() {
			const input = document.getElementById('messageInput');
			const message = input.value.trim();
			if (message) {
				addMessage(message, 'user');
				vscode.postMessage({ command: 'sendMessage', text: message });
				input.value = '';
			}
		}
		
		function addMessage(text, sender) {
			const container = document.getElementById('chatContainer');
			const messageDiv = document.createElement('div');
			messageDiv.className = \`message \${sender}-message\`;
			messageDiv.textContent = text;
			container.appendChild(messageDiv);
			container.scrollTop = container.scrollHeight;
		}
		
		// Handle messages from extension
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.command === 'addMessage') {
				addMessage(message.text, message.sender);
			}
		});
		
		// Send message on Enter key
		document.getElementById('messageInput').addEventListener('keypress', function(e) {
			if (e.key === 'Enter') {
				sendMessage();
			}
		});
	</script>
</body>
</html>`;
	}
}

// AI Tools Provider
class AIToolsProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'aiToolsView';

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(webviewView: vscode.WebviewView) {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.html = this._getAIToolsHtml();
	}

	private _getAIToolsHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>AI Tools</title>
	<style>
		body { 
			font-family: var(--vscode-font-family);
			padding: 10px;
			background: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
		}
		.tool-button {
			width: 100%;
			margin: 5px 0;
			padding: 10px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 2px;
			cursor: pointer;
			text-align: left;
		}
		.tool-button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.tool-section {
			margin: 15px 0;
			border-top: 1px solid var(--vscode-panel-border);
			padding-top: 10px;
		}
		.section-title {
			font-weight: bold;
			margin-bottom: 8px;
			color: var(--vscode-foreground);
		}
	</style>
</head>
<body>
	<div class="tool-section">
		<div class="section-title">Code Analysis</div>
		<button class="tool-button">Analyze RTL</button>
		<button class="tool-button">Coverage Review</button>
		<button class="tool-button">Find Bugs</button>
	</div>
	
	<div class="tool-section">
		<div class="section-title">Testbench Generation</div>
		<button class="tool-button">Generate TB</button>
		<button class="tool-button">Create Assertions</button>
		<button class="tool-button">Add Constraints</button>
	</div>
	
	<div class="tool-section">
		<div class="section-title">Documentation</div>
		<button class="tool-button">Generate Docs</button>
		<button class="tool-button">Create Reports</button>
	</div>
</body>
</html>`;
	}
}

// Physical Design Provider  
class PhysicalDesignProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'physicalDesignView';

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(webviewView: vscode.WebviewView) {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.html = this._getPhysicalDesignHtml();
	}

	private _getPhysicalDesignHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Physical Design</title>
	<style>
		body { 
			font-family: var(--vscode-font-family);
			padding: 10px;
			background: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
		}
		.placeholder {
			text-align: center;
			padding: 40px;
			color: var(--vscode-descriptionForeground);
			border: 2px dashed var(--vscode-panel-border);
			border-radius: 4px;
		}
		.placeholder-icon {
			font-size: 48px;
			margin-bottom: 16px;
		}
		.coming-soon {
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			padding: 4px 8px;
			border-radius: 12px;
			font-size: 12px;
			margin-top: 10px;
		}
	</style>
</head>
<body>
	<div class="placeholder">
		<div class="placeholder-icon">🔧</div>
		<h3>Physical Design View</h3>
		<p>This is where your circuit layouts will be displayed.</p>
		<p>Future features:</p>
		<ul style="text-align: left; display: inline-block;">
			<li>ODB file visualization</li>
			<li>Floorplan viewer</li>
			<li>Placement &amp; routing display</li>
			<li>OpenROAD integration</li>
		</ul>
		<div class="coming-soon">Coming Soon</div>
	</div>
</body>
</html>`;
	}
}

// Main extension activation
export function activate(context: vscode.ExtensionContext) {
	console.log('Verification Workbench extension is now active!');

	// Set initial context values
	vscode.commands.executeCommand('setContext', 'verificationWorkbench.aiPanelVisible', true);
	vscode.commands.executeCommand('setContext', 'verificationWorkbench.physicalViewVisible', false);

	// Register providers
	const aiChatProvider = new AIChatProvider(context.extensionUri);
	const aiToolsProvider = new AIToolsProvider(context.extensionUri);
	const physicalDesignProvider = new PhysicalDesignProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(AIChatProvider.viewType, aiChatProvider),
		vscode.window.registerWebviewViewProvider(AIToolsProvider.viewType, aiToolsProvider),
		vscode.window.registerWebviewViewProvider(PhysicalDesignProvider.viewType, physicalDesignProvider)
	);

	// Register commands
	const showPhysicalDesign = vscode.commands.registerCommand('verificationWorkbench.showPhysicalDesign', () => {
		vscode.commands.executeCommand('setContext', 'verificationWorkbench.physicalViewVisible', true);
		vscode.commands.executeCommand('verificationPhysical.focus');
		vscode.window.showInformationMessage('Physical Design view enabled!');
	});

	const hidePhysicalDesign = vscode.commands.registerCommand('verificationWorkbench.hidePhysicalDesign', () => {
		vscode.commands.executeCommand('setContext', 'verificationWorkbench.physicalViewVisible', false);
		vscode.window.showInformationMessage('Physical Design view hidden!');
	});

	const showAIPanel = vscode.commands.registerCommand('verificationWorkbench.showAIPanel', () => {
		vscode.commands.executeCommand('setContext', 'verificationWorkbench.aiPanelVisible', true);
		vscode.commands.executeCommand('verificationAI.focus');
		vscode.window.showInformationMessage('AI Assistant panel shown!');
	});

	const toggleLayout = vscode.commands.registerCommand('verificationWorkbench.toggleLayout', () => {
		// Toggle both AI and Physical panels
		vscode.commands.executeCommand('verificationWorkbench.showAIPanel');
		vscode.commands.executeCommand('verificationWorkbench.showPhysicalDesign');
		vscode.window.showInformationMessage('Verification layout activated!');
	});

	context.subscriptions.push(showPhysicalDesign, hidePhysicalDesign, showAIPanel, toggleLayout);

	// Auto-setup verification layout
	setTimeout(() => {
		vscode.commands.executeCommand('verificationWorkbench.showAIPanel');
	}, 1000);
}

export function deactivate() {}
