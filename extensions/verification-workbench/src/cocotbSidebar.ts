/*---------------------------------------------------------------------------------------------
 *  Cocotb Sidebar: provides test management interface
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { CocotbRunner } from "./cocotbRunner";

export class CocotbSidebar implements vscode.WebviewViewProvider {
	public static readonly viewType = "cocotbSidebar";
	private static _instance: CocotbSidebar | undefined;

	private _view?: vscode.WebviewView;
	private _runner: CocotbRunner;

	constructor(private readonly _extensionUri: vscode.Uri) {
		this._runner = CocotbRunner.getInstance();
		CocotbSidebar._instance = this;
	}

	public static getInstance(): CocotbSidebar | undefined {
		return CocotbSidebar._instance;
	}

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

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// Handle messages from webview
		webviewView.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case "runTests": {
						await this._runner.runTests();
						break;
					}
					case "stopTests": {
						this._runner.stopTests();
						break;
					}
					case "cleanTests": {
						await this._runner.cleanTests();
						break;
					}
					case "checkPrerequisites": {
						const results = await this._runner.checkPrerequisites();
						this._postMessage({ command: "prerequisites", payload: results });
						break;
					}
					case "installCocotb": {
						const success = await this._runner.installCocotb();
						this._postMessage({ command: "installResult", payload: { component: "cocotb", success } });
						break;
					}
					case "installSimulator": {
						const success = await this._runner.installSimulator();
						this._postMessage({ command: "installResult", payload: { component: "simulator", success } });
						break;
					}
					case "browseTestDirectory": {
						await vscode.commands.executeCommand("cocotb.setTestDirectory");
						// Update the display
						const cfg = vscode.workspace.getConfiguration();
						const testDir = cfg.get<string>("cocotb.testDirectory", "");
						this._postMessage({ command: "updateTestDirectory", payload: testDir });
						break;
					}
					case "generateMakefile": {
						await vscode.commands.executeCommand("cocotb.generateMakefile");
						break;
					}
					case "installGtkwave": {
						const success = await this._runner.installGtkwave();
						this._postMessage({ command: "installResult", payload: { component: "gtkwave", success } });
						break;
					}
				}
			},
			undefined,
			[],
		);

		// Update status periodically
		const statusTimer = setInterval(() => {
			this._postMessage({
				command: "status",
				payload: {
					running: this._runner.isRunning(),
					timestamp: Date.now()
				}
			});
		}, 1000);

		webviewView.onDidDispose(() => {
			clearInterval(statusTimer);
		});
	}

	private _postMessage(msg: any) {
		if (this._view) {
			this._view.webview.postMessage(msg);
		}
	}

	public postStatus(status: 'running' | 'stopped' | 'cleaned') {
		this._postMessage({ command: 'status', payload: status });
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Cocotb Tests</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			padding: 12px;
			margin: 0;
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
		}
		.header {
			font-weight: 600;
			margin-bottom: 12px;
			padding-bottom: 8px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.button {
			width: 100%;
			padding: 10px 16px;
			margin: 6px 0;
			border: 1px solid #00ff41;
			background: linear-gradient(135deg, #00ff41 0%, #00cc33 100%);
			color: #000000;
			border-radius: 6px;
			cursor: pointer;
			font-family: var(--vscode-font-family);
			font-weight: 600;
			font-size: 13px;
			transition: all 0.2s ease;
			box-shadow: 0 2px 4px rgba(0, 255, 65, 0.3);
		}
		.button:hover {
			background: linear-gradient(135deg, #00ff41 0%, #00ff66 100%);
			box-shadow: 0 4px 8px rgba(0, 255, 65, 0.4);
			transform: translateY(-1px);
		}
		.button:active {
			transform: translateY(0);
			box-shadow: 0 2px 4px rgba(0, 255, 65, 0.3);
		}
		.button:disabled {
			opacity: 0.6;
			cursor: not-allowed;
		}
		.status {
			margin: 8px 0;
			padding: 10px 12px;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 600;
			text-align: center;
		}
		.status.running {
			background: linear-gradient(135deg, rgba(0, 255, 65, 0.2) 0%, rgba(0, 204, 51, 0.2) 100%);
			border: 1px solid #00ff41;
			color: #00ff41;
		}
		.status.stopped {
			background: rgba(255, 255, 255, 0.1);
			border: 1px solid rgba(255, 255, 255, 0.3);
			color: var(--vscode-foreground);
		}
		.status.cleaned {
			background: linear-gradient(135deg, rgba(64, 255, 64, 0.2) 0%, rgba(0, 204, 102, 0.2) 100%);
			border: 1px solid #40ff40;
			color: #40ff40;
		}
		.prerequisites {
			margin: 8px 0;
			font-size: 12px;
		}
		.prerequisite {
			display: flex;
			justify-content: space-between;
			margin: 2px 0;
		}

		.config-item {
			margin-bottom: 15px;
		}

		.config-item label {
			display: block;
			margin-bottom: 5px;
			font-weight: bold;
			color: #40ff40;
		}

		.path-display {
			margin-top: 8px;
			padding: 8px 10px;
			background: #1e2a1e;
			border: 1px solid #40ff40;
			border-radius: 4px;
			color: #ffffff;
			font-size: 12px;
			font-family: 'Courier New', monospace;
			word-break: break-all;
			border-left: 3px solid #40ff40;
		}

		.button.small {
			padding: 6px 10px;
			font-size: 11px;
			min-width: auto;
		}
		.prerequisite.ok {
			color: var(--vscode-testing-iconPassed);
		}
		.prerequisite.error {
			color: var(--vscode-testing-iconFailed);
		}
		.section {
			margin: 12px 0;
		}
		.section-title {
			font-weight: 600;
			margin-bottom: 8px;
			font-size: 13px;
		}
		input[type="text"] {
			width: 100%;
			padding: 6px 8px;
			margin: 4px 0;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 4px;
			font-family: var(--vscode-font-family);
		}
	</style>
</head>
<body>
	<div class="header">Cocotb Test Manager</div>

	<div class="section">
		<div class="section-title">Test Directory</div>
		<div class="config-item">
			<label>Test Directory:</label>
			<button id="browseBtn" class="button">📁 Browse</button>
			<div id="testDirPath" class="path-display">Auto-detected or click Browse...</div>
		</div>
		<button id="generateMakefileBtn" class="button">📄 Generate Makefile</button>
	</div>

	<div class="section">
		<div class="section-title">Setup</div>
		<button id="checkBtn" class="button">🔍 Check Prerequisites</button>
		<div id="prerequisites" class="prerequisites" style="display: none;">
			<div class="prerequisite">
				<span>Python:</span>
				<span id="python-status">Unknown</span>
			</div>
			<div class="prerequisite">
				<span>Cocotb:</span>
				<span id="cocotb-status">Unknown</span>
				<button id="installCocotbBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
			</div>
			<div class="prerequisite">
				<span>Simulator:</span>
				<span id="simulator-status">Unknown</span>
				<button id="installSimulatorBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
			</div>
			<div class="prerequisite">
				<span>GTKWave:</span>
				<span id="gtkwave-status">Unknown</span>
				<button id="installGtkwaveBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
			</div>
		</div>
	</div>

	<div class="section">
		<div class="section-title">Testing</div>
		<button id="runBtn" class="button">▶️ Run Tests</button>
		<button id="stopBtn" class="button" disabled>⏹️ Stop Tests</button>
		<button id="cleanBtn" class="button">🧹 Clean Tests</button>
	</div>

	<div class="section">
		<div class="section-title">Status</div>
		<div id="status" class="status stopped">Tests stopped</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		let isRunning = false;

		function updateStatus(status) {
			const statusEl = document.getElementById('status');
			const runBtn = document.getElementById('runBtn');
			const stopBtn = document.getElementById('stopBtn');

			switch (status) {
				case 'running':
					isRunning = true;
					statusEl.textContent = 'Tests running...';
					statusEl.className = 'status running';
					runBtn.disabled = true;
					stopBtn.disabled = false;
					break;
				case 'stopped':
					isRunning = false;
					statusEl.textContent = 'Tests stopped';
					statusEl.className = 'status stopped';
					runBtn.disabled = false;
					stopBtn.disabled = true;
					break;
				case 'cleaned':
					isRunning = false;
					statusEl.textContent = 'Tests cleaned';
					statusEl.className = 'status cleaned';
					runBtn.disabled = false;
					stopBtn.disabled = true;
					// Auto-revert to stopped after 3 seconds
					setTimeout(() => {
						updateStatus('stopped');
					}, 3000);
					break;
				default:
					// Handle legacy boolean input for backward compatibility
					if (status === true) {
						updateStatus('running');
					} else if (status === false) {
						updateStatus('stopped');
					}
			}
		}

		function updatePrerequisites(results) {
			const prereqEl = document.getElementById('prerequisites');
			document.getElementById('python-status').textContent = results.python ? '✓ OK' : '✗ Missing';
			document.getElementById('python-status').className = results.python ? 'prerequisite ok' : 'prerequisite error';

			document.getElementById('cocotb-status').textContent = results.cocotb ? '✓ OK' : '✗ Missing';
			document.getElementById('cocotb-status').className = results.cocotb ? 'prerequisite ok' : 'prerequisite error';

			document.getElementById('simulator-status').textContent = results.simulator ? '✓ OK' : '✗ Missing';
			document.getElementById('simulator-status').className = results.simulator ? 'prerequisite ok' : 'prerequisite error';

			document.getElementById('gtkwave-status').textContent = results.gtkwave ? '✓ OK' : '✗ Missing';
			document.getElementById('gtkwave-status').className = results.gtkwave ? 'prerequisite ok' : 'prerequisite error';

			prereqEl.style.display = 'block';
		}

		// Event listeners

		// Configuration
		document.getElementById('browseBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'browseTestDirectory' });
		});

		document.getElementById('generateMakefileBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'generateMakefile' });
		});

		// Test execution
		document.getElementById('runBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'runTests' });
		});

		document.getElementById('stopBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'stopTests' });
		});

		document.getElementById('cleanBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'cleanTests' });
		});

		document.getElementById('checkBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'checkPrerequisites' });
		});

		document.getElementById('installCocotbBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'installCocotb' });
		});

		document.getElementById('installSimulatorBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'installSimulator' });
		});

		document.getElementById('installGtkwaveBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'installGtkwave' });
		});


		// Update test directory display
		function updateTestDirectory(testDir) {
			const testDirDisplay = document.getElementById('testDirPath');
			testDirDisplay.textContent = testDir || 'Auto-detected or click Browse...';
		}

		// Initialize test directory display
		updateTestDirectory('${vscode.workspace.getConfiguration().get<string>("cocotb.testDirectory", "")}');

		// Handle messages from extension
		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.command) {
				case 'status':
					// Handle both legacy format (boolean) and new format (string)
					if (typeof message.payload === 'string') {
						updateStatus(message.payload);
					} else if (message.payload.running !== undefined) {
						updateStatus(message.payload.running ? 'running' : 'stopped');
					}
					break;
				case 'prerequisites':
					updatePrerequisites(message.payload);
					break;
				case 'updateTestDirectory':
					updateTestDirectory(message.payload);
					break;
				case 'installResult':
					// Refresh prerequisites after installation
					setTimeout(() => {
						vscode.postMessage({ command: 'checkPrerequisites' });
					}, 1000);
					break;
			}
		});
	</script>
</body>
</html>`;
	}
}
