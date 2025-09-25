/*---------------------------------------------------------------------------------------------
 *  Cocotb Sidebar: provides test management interface
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { CocotbRunner } from "./cocotbRunner";
import { VerilatorRunner } from "./verilatorRunner";

export class CocotbSidebar implements vscode.WebviewViewProvider {
	public static readonly viewType = "cocotbSidebar";
	private _view?: vscode.WebviewView;
	private _runner: CocotbRunner;

	constructor(private readonly _extensionUri: vscode.Uri) {
		this._runner = CocotbRunner.getInstance();
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
						// Also update path display from config
						const cfg = vscode.workspace.getConfiguration();
						const dir = cfg.get<string>("cocotb.testDirectory", "");
						this._postMessage({ command: "pathUpdate", payload: { testDirectory: dir } });
						break;
					}
					case "setTestDirectory": {
						await this._runner.setTestDirectory();
						const cfg = vscode.workspace.getConfiguration();
						const dir = cfg.get<string>("cocotb.testDirectory", "");
						this._postMessage({ command: "pathUpdate", payload: { testDirectory: dir } });
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
					case "installGtkwave": {
						const success = await this._runner.installGtkwave();
						this._postMessage({ command: "installResult", payload: { component: "gtkwave", success } });
						break;
					}
					case "installVerilator": {
						const ver = VerilatorRunner.getInstance();
						await ver.installVerilator();
						this._postMessage({ command: "installResult", payload: { component: "verilator", success: true } });
						break;
					}
					case "generateMakefile": {
						const cfgDir = vscode.workspace.getConfiguration().get<string>("cocotb.testDirectory", "");
						const testDir = cfgDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
						const designFile = message.designFile;
						const testFile = message.testFile;
						await vscode.commands.executeCommand("chipAssistant.generateCocotbMakefile", { testDir, designFile, testFile });
						break;
					}
					case "implementTests": {
						// Trigger AI assistant to help implement tests
						await vscode.commands.executeCommand("chipAssistant.implementCocotbTests");
						break;
					}
					case "viewWaveforms": {
						await this._runner.viewWaveforms();
						break;
					}
					case "openGtkwaveGuiOnly": {
						await this._runner.openGtkwaveGuiOnly();
						break;
					}
				}
			},
			undefined,
			[],
		);

		// Removed periodic status updates since Test Control UI is no longer shown
	}

	private _postMessage(msg: any) {
		if (this._view) {
			this._view.webview.postMessage(msg);
		}
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
		.prerequisites {
			margin: 8px 0;
			font-size: 12px;
		}
		.prerequisite {
			display: flex;
			justify-content: space-between;
			margin: 2px 0;
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
		<button id="browseBtn" class="button">📁 Browse Test Directory</button>
		<div id="pathDisplay" style="margin-top: 4px; font-size: 11px; word-break: break-all; overflow-wrap: anywhere; white-space: normal;"></div>
		<button id="runBtn" class="button" style="margin-top: 8px;">▶️ Run Tests</button>
		<button id="stopBtn" class="button">⏹️ Stop Tests</button>
		<button id="cleanBtn" class="button">🧹 Clean Tests</button>
		<button id="viewWaveformsBtn" class="button" style="margin-top: 8px;">🌊 View Latest Waveform</button>
		<button id="openGtkwaveBtn" class="button">🪟 Open GTKWave GUI</button>
	</div>

	<div class="section">
		<div class="section-title">Setup</div>
		<button id="checkBtn" class="button">Check Prerequisites</button>
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
				<span>Icarus (iverilog):</span>
				<span id="icarus-status">Unknown</span>
				<button id="installIcarusBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
			</div>
			<div class="prerequisite">
				<span>Verilator:</span>
				<span id="verilator-status">Unknown</span>
				<button id="installVerilatorBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
			</div>
			<div class="prerequisite">
				<span>GTKWave:</span>
				<span id="gtkwave-status">Unknown</span>
				<button id="installGtkwaveBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
			</div>
		</div>
	</div>

	<div class="section">
		<div class="section-title">Generate Makefile</div>
		<input type="text" id="designFile" placeholder="Design file path (e.g., design.v)">
		<input type="text" id="testFile" placeholder="Test file path (e.g., test_design.py)">
		<button id="generateBtn" class="button">Generate Makefile</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		function updateStatus(_running) {}

		function updatePrerequisites(results) {
			const prereqEl = document.getElementById('prerequisites');
			document.getElementById('python-status').textContent = results.python ? '✓ OK' : '✗ Missing';
			document.getElementById('python-status').className = results.python ? 'prerequisite ok' : 'prerequisite error';

			document.getElementById('cocotb-status').textContent = results.cocotb ? '✓ OK' : '✗ Missing';
			document.getElementById('cocotb-status').className = results.cocotb ? 'prerequisite ok' : 'prerequisite error';

			// Icarus
			document.getElementById('icarus-status').textContent = results.icarus ? '✓ OK' : '✗ Missing';
			document.getElementById('icarus-status').className = results.icarus ? 'prerequisite ok' : 'prerequisite error';

			// Verilator (read-only status here)
			document.getElementById('verilator-status').textContent = results.verilator ? '✓ OK' : '✗ Missing';
			document.getElementById('verilator-status').className = results.verilator ? 'prerequisite ok' : 'prerequisite error';

			// GTKWave
			document.getElementById('gtkwave-status').textContent = results.gtkwave ? '✓ OK' : '✗ Missing';
			document.getElementById('gtkwave-status').className = results.gtkwave ? 'prerequisite ok' : 'prerequisite error';

			prereqEl.style.display = 'block';
		}

		// Event listeners
		document.getElementById('runBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'runTests' });
		});

		document.getElementById('stopBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'stopTests' });
		});

		document.getElementById('cleanBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'cleanTests' });
		});

		document.getElementById('viewWaveformsBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'viewWaveforms' });
		});

		document.getElementById('openGtkwaveBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'openGtkwaveGuiOnly' });
		});

		document.getElementById('checkBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'checkPrerequisites' });
		});

		document.getElementById('browseBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'setTestDirectory' });
		});

		document.getElementById('installCocotbBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'installCocotb' });
		});

		document.getElementById('installIcarusBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'installSimulator' });
		});

		document.getElementById('installGtkwaveBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'installGtkwave' });
		});

		document.getElementById('installVerilatorBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'installVerilator' });
		});

		document.getElementById('generateBtn').addEventListener('click', () => {
			const designFile = document.getElementById('designFile').value;
			const testFile = document.getElementById('testFile').value;
			if (designFile && testFile) {
				vscode.postMessage({
					command: 'generateMakefile',
					designFile: designFile,
					testFile: testFile
				});
			} else {
				vscode.window.showErrorMessage('Please provide both design file and test file paths');
			}
		});

		// Handle messages from extension
		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.command) {
				case 'status':
					updateStatus(message.payload.running);
					break;
				case 'prerequisites':
					updatePrerequisites(message.payload);
					break;
				case 'installResult':
					// Refresh prerequisites after installation
					setTimeout(() => {
						vscode.postMessage({ command: 'checkPrerequisites' });
					}, 1000);
					break;
				case 'pathUpdate': {
					const el = document.getElementById('pathDisplay');
					if (el) el.textContent = message.payload?.testDirectory || '';
					break;
				}
			}
		});
	</script>
</body>
</html>`;
	}
}
