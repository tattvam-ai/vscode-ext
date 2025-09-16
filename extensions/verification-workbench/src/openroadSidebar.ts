/*---------------------------------------------------------------------------------------------
 *  OpenROAD Sidebar: actions and status
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { OpenroadRunner } from "./openroadRunner";
import * as fs from "fs";
import * as path from "path";

export class OpenroadSidebar implements vscode.WebviewViewProvider {
	public static readonly viewType = "openroadSidebar";
	private _view?: vscode.WebviewView;
	private statusTimer?: NodeJS.Timer;
	private scanTimer?: NodeJS.Timer;

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

		this.statusTimer = setInterval(() => this.postStatus(), 1000);
		this.scanTimer = setInterval(() => this.postAutoDetectedMetrics().catch(() => { }), 5000);
		this.postStatus();
		this.postAutoDetectedMetrics().catch(() => { });
	}

	dispose() {
		if (this.statusTimer) clearInterval(this.statusTimer);
		if (this.scanTimer) clearInterval(this.scanTimer);
	}

	private postStatus() {
		if (!this._view) return;
		const running = OpenroadRunner.getInstance().isRunning();
		this._view.webview.postMessage({ type: "status", running });
	}

	private async postAutoDetectedMetrics() {
		if (!this._view) return;
		const cfg = vscode.workspace.getConfiguration();
		const flowHome = cfg.get<string>("openroad.flow.flowHome", "");
		const resultsRootOverride = cfg.get<string>("openroad.flow.resultsRoot", "");
		const platform = cfg.get<string>("openroad.flow.platform", "");
		const designName = cfg.get<string>("openroad.flow.designName", "");
		const flowVariant = cfg.get<string>("openroad.flow.flowVariant", "base");
		if (!flowHome || !platform || !designName) {
			this._view.webview.postMessage({ type: "metrics", data: { found: false } });
			return;
		}
		const candidateRoot = resultsRootOverride && resultsRootOverride.trim().length > 0
			? resultsRootOverride
			: path.join(flowHome, "results", platform, designName, flowVariant);
		const runDir = await this.findLatestDirectory(candidateRoot);
		if (!runDir) {
			this._view.webview.postMessage({ type: "metrics", data: { found: false } });
			return;
		}
		const reportsDir = runDir.replace(path.sep + "results" + path.sep, path.sep + "reports" + path.sep);
		// Prefer canonical finish report name if available
		let timingReport = await this.findFirstFile(reportsDir, [".rpt"], 6, /6_finish\.rpt$/i);
		if (!timingReport) {
			timingReport = await this.findFirstFile(reportsDir, [".rpt", ".report", ".txt"], 6, /finish|timing|slack|wns|tns/i);
		}
		const timing = await this.parseTimingMetrics(timingReport);
		this._view.webview.postMessage({
			type: "metrics", data: {
				found: true,
				runDir,
				timing,
				metrics: null,
			}
		});
	}

	private async findLatestDirectory(root: string): Promise<string | null> {
		try {
			const entries = await fs.promises.readdir(root, { withFileTypes: true });
			const dirs = entries.filter(e => e.isDirectory());
			if (dirs.length === 0) {
				// Some flows place artifacts directly in the variant directory
				return (await this.pathExists(root)) ? root : null;
			}
			const stats = await Promise.all(dirs.map(async d => ({ name: d.name, stat: await fs.promises.stat(path.join(root, d.name)) })));
			stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
			return path.join(root, stats[0].name);
		} catch {
			return null;
		}
	}

	private async pathExists(p: string): Promise<boolean> {
		try { await fs.promises.access(p, fs.constants.R_OK); return true; } catch { return false; }
	}

	private async findFirstFile(root: string, exts: string[], maxDepth = 3, nameRegex?: RegExp): Promise<string | null> {
		const walk = async (dir: string, depth: number): Promise<string | null> => {
			if (depth > maxDepth) return null;
			let entries: fs.Dirent[] = [];
			try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return null; }
			for (const ent of entries) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					const n = await walk(full, depth + 1);
					if (n) return n;
				} else {
					const ext = path.extname(ent.name).toLowerCase();
					if (exts.includes(ext) && (!nameRegex || nameRegex.test(ent.name))) {
						return full;
					}
				}
			}
			return null;
		};
		return await walk(root, 0);
	}

	private async parseTimingMetrics(reportPath: string | null): Promise<{ wns?: number; tns?: number } | null> {
		if (!reportPath) return null;
		try {
			const content = await fs.promises.readFile(reportPath, "utf8");
			// Match forms like:
			//   tns -62.80
			//   wns -1.65
			//   worst slack -1.65
			// Be generous with spaces and case
			const tnsMatch = content.match(/^\s*tns\s+(-?[0-9]+(?:\.[0-9]+)?)\s*$/im);
			let wnsMatch = content.match(/^\s*wns\s+(-?[0-9]+(?:\.[0-9]+)?)\s*$/im);
			if (!wnsMatch) {
				wnsMatch = content.match(/^\s*worst\s+slack\s+(-?[0-9]+(?:\.[0-9]+)?)\s*$/im);
			}
			const res: any = {};
			if (wnsMatch) res.wns = Number(wnsMatch[1]);
			if (tnsMatch) res.tns = Number(tnsMatch[1]);
			return Object.keys(res).length ? res : null;
		} catch {
			return null;
		}
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
		.kv{display:grid; grid-template-columns: 110px 1fr; gap:6px; font-size:12px}
		.code{font-family: var(--vscode-editor-font-family); font-size:11px; opacity:0.8}
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

	<div class="section">Latest Results</div>
	<div class="kv">
		<div>Run dir</div><div id="runDir" class="code">-</div>
		<div>WNS</div><div id="wns">-</div>
		<div>TNS</div><div id="tns">-</div>
	</div>

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
			if (m.type === 'metrics') {
				const d = m.data || {};
				document.getElementById('runDir').textContent = d.found ? (d.runDir || '-') : '-';
				document.getElementById('wns').textContent = d.found && d.timing && typeof d.timing.wns !== 'undefined' ? String(d.timing.wns) : '-';
				document.getElementById('tns').textContent = d.found && d.timing && typeof d.timing.tns !== 'undefined' ? String(d.timing.tns) : '-';
			}
		});
	</script>
</body>
</html>`;
	}
}
