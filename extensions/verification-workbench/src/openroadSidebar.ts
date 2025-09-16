/*---------------------------------------------------------------------------------------------
 *  OpenROAD Sidebar: actions and status
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { OpenroadRunner } from "./openroadRunner";

export class OpenroadSidebar implements vscode.WebviewViewProvider {
	public static readonly viewType = "openroadSidebar";
	private _view?: vscode.WebviewView;
	private timer?: NodeJS.Timer;

	constructor(private readonly extensionUri: vscode.Uri) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		webviewView.webview.html = this.getHtml();

		webviewView.webview.onDidReceiveMessage(async (m) => {
			switch (m?.type) {
				case "cmd":
					await vscode.commands.executeCommand(String(m.id || ""));
					break;
			}
		});

		this.timer = setInterval(() => this.postStatus(), 1000);
		this.postStatus();
	}

	dispose() {
		if (this.timer) clearInterval(this.timer);
	}

	private postStatus() {
		if (!this._view) return;
		const running = OpenroadRunner.getInstance().isRunning();
		this._view.webview.postMessage({ type: "status", running });
	}

	private getHtml() {
		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8" />
	<style>
		body{font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin:0; padding:8px}
		button{width:100%; margin:4px 0; padding:6px 8px}
		.section{margin-top:12px; font-weight:600}
		.small{opacity:0.8; font-size:12px}
	</style>
</head>
<body>
	<div class="section">Actions</div>
	<button id="run">Run Flow</button>
	<button id="stop">Stop Flow</button>
	<button id="clean">Clean All</button>
	<button id="gui">Show GUI (gui_final)</button>
	<button id="cfg">Configure Flow</button>

	<div class="section">Status</div>
	<div id="status" class="small">Idle</div>

	<script>
		const vscode = acquireVsCodeApi();
		document.getElementById('run').onclick = () => vscode.postMessage({ type: 'cmd', id: 'openroad.runFlow' });
		document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'cmd', id: 'openroad.stopFlow' });
		document.getElementById('clean').onclick = () => vscode.postMessage({ type: 'cmd', id: 'openroad.cleanAll' });
		document.getElementById('gui').onclick = () => vscode.postMessage({ type: 'cmd', id: 'openroad.guiFinal' });
		document.getElementById('cfg').onclick = () => vscode.postMessage({ type: 'cmd', id: 'openroad.configureFlow' });
		window.addEventListener('message', (e) => {
			const m = e.data || {};
			if (m.type === 'status') {
				document.getElementById('status').textContent = m.running ? 'Running' : 'Idle';
			}
		});
	</script>
</body>
</html>`;
	}
}
