/*---------------------------------------------------------------------------------------------
 *  Verilator Sidebar: provides UI for Verilator operations
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { VerilatorRunner } from "./verilatorRunner";

export class VerilatorSidebar implements vscode.WebviewViewProvider {
  public static readonly viewType = "verilatorSidebar";
  private static instance: VerilatorSidebar | undefined;

  private _view?: vscode.WebviewView;
  private _runner: VerilatorRunner;

  private constructor() {
    this._runner = VerilatorRunner.getInstance();
  }

  public static getInstance(): VerilatorSidebar {
    if (!VerilatorSidebar.instance) {
      VerilatorSidebar.instance = new VerilatorSidebar();
    }
    return VerilatorSidebar.instance;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "checkPrerequisites": {
          const results = await this._runner.checkPrerequisites();
          this._postMessage({ command: "prerequisites", payload: results });
          break;
        }
        case "compile": await this._runner.compile(); break;
        case "runSimulation": await this._runner.runSimulation(); break;
        case "stopSimulation": await this._runner.stopSimulation(); break;
        case "clean": await this._runner.clean(); break;
        case "browseTestDirectory": {
          await vscode.commands.executeCommand("verilator.setTestDirectory");
          const cfg = vscode.workspace.getConfiguration();
          const testDir = cfg.get<string>("verilator.testDirectory", "");
          this._postMessage({ command: "updateTestDirectory", payload: testDir });
          break;
        }
        case "installVerilator": await this._runner.installVerilator(); break;
        case "installCpp": await this._runner.installCppCompiler(); break;
        case "installMake": await this._runner.installMake(); break;
        case "installSystemC": await this._runner.installSystemC(); break;
        case "requestSettings": {
          const cfg = vscode.workspace.getConfiguration();
          const enableWall = cfg.get<boolean>("verilator.enableWall", true);
          const jobs = cfg.get<number>("verilator.jobs", 0);
          this._postMessage({ command: "settings", payload: { enableWall, jobs } });
          break;
        }
        case "setEnableWall": {
          const cfg = vscode.workspace.getConfiguration();
          await cfg.update("verilator.enableWall", !!message.payload, vscode.ConfigurationTarget.Workspace);
          break;
        }
        case "setJobs": {
          const cfg = vscode.workspace.getConfiguration();
          const val = Number(message.payload);
          await cfg.update("verilator.jobs", isNaN(val) ? 0 : val, vscode.ConfigurationTarget.Workspace);
          break;
        }
      }
    });

    // Initialize test directory display from current settings on first load
    const cfg = vscode.workspace.getConfiguration();
    const testDir = cfg.get<string>("verilator.testDirectory", "");
    this._postMessage({ command: "updateTestDirectory", payload: testDir });
  }

  private _postMessage(msg: any) { if (this._view) this._view.webview.postMessage(msg); }
  public postStatus(status: 'running' | 'stopped' | 'cleaned') { this._postMessage({ command: 'status', payload: status }); }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verilator</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 12px; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); }
    .header { font-weight: 600; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .button { width: 100%; padding: 10px 16px; margin: 6px 0; border: 1px solid #00ff41; background: linear-gradient(135deg, #00ff41 0%, #00cc33 100%); color: #000; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; box-shadow: 0 2px 4px rgba(0,255,65,0.3); }
    .button.small { padding: 6px 10px; font-size: 11px; min-width: auto; }
    .status { margin: 8px 0; padding: 10px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; text-align: center; }
    .status.running { background: linear-gradient(135deg, rgba(0,255,65,0.2), rgba(0,204,51,0.2)); border: 1px solid #00ff41; color: #00ff41; }
    .status.stopped { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.3); }
    .status.cleaned { background: linear-gradient(135deg, rgba(64,255,64,0.2), rgba(0,204,102,0.2)); border: 1px solid #40ff40; color: #40ff40; }
    .prerequisites { margin: 8px 0; font-size: 12px; }
    .prerequisite { display: flex; justify-content: space-between; align-items: center; margin: 2px 0; }
    .path-display { margin-top: 8px; padding: 8px 10px; background: #1e2a1e; border: 1px solid #40ff40; border-radius: 4px; color: #fff; font-size: 12px; font-family: 'Courier New', monospace; border-left: 3px solid #40ff40; word-break: break-all; overflow-wrap: anywhere; white-space: normal; }
    .section { margin: 12px 0; }
    .section-title { font-weight: 600; margin-bottom: 8px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="header">Verilator Manager</div>

  <div class="section">
    <div class="section-title">Test Directory</div>
    <button id="browseBtn" class="button">📁 Browse</button>
    <div id="testDirPath" class="path-display">Auto-detected or click Browse...</div>
  </div>

  <div class="section">
    <div class="section-title">Setup</div>
    <button id="checkPrerequisitesBtn" class="button">🔍 Check Prerequisites</button>
    <div id="prerequisites" class="prerequisites" style="display: none;">
      <div class="prerequisite">
        <span>Verilator:</span>
        <span id="verilator-status">Unknown</span>
        <button id="installVerilatorBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
      </div>
      <div class="prerequisite">
        <span>C++ Compiler:</span>
        <span id="cpp-status">Unknown</span>
        <button id="installCppBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
      </div>
      <div class="prerequisite">
        <span>Make:</span>
        <span id="make-status">Unknown</span>
        <button id="installMakeBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Install</button>
      </div>
      <div class="prerequisite">
        <span>SystemC:</span>
        <span id="systemc-status">Unknown</span>
        <button id="installSystemCBtn" class="button" style="width: auto; margin-left: 8px; padding: 4px 8px; font-size: 11px;">Link</button>
      </div>
      <div id="systemc-paths" style="font-size: 11px; opacity: 0.85; margin-top: 4px; display: none;"></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Build Options</div>
    <label><input type="checkbox" id="enableWallChk" checked> Enable -Wall warnings</label>
    <div style="margin-top:6px;">
      <label>Parallel Jobs (-j) </label>
      <select id="jobsSelect">
        <option value="0">All cores (default)</option>
        <option value="-1">Disable parallel (-j not passed)</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="4">4</option>
        <option value="8">8</option>
      </select>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Compilation & Simulation</div>
    <button id="compileBtn" class="button">🔨 Compile</button>
    <button id="runBtn" class="button">▶️ Run Simulation</button>
    <button id="stopBtn" class="button" disabled>⏹️ Stop Simulation</button>
    <button id="cleanBtn" class="button">🧹 Clean</button>
  </div>

  <div class="section">
    <div class="section-title">Status</div>
    <div id="status" class="status stopped">Ready</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function updatePrerequisites(p) {
      const prereqDiv = document.getElementById('prerequisites');
      prereqDiv.style.display = 'block';
      document.getElementById('verilator-status').textContent = p.verilator ? 'OK' : 'Missing';
      document.getElementById('cpp-status').textContent = p.cppCompiler ? 'OK' : 'Missing';
      document.getElementById('make-status').textContent = p.make ? 'OK' : 'Missing';
      const sysOk = !!p.systemc;
      document.getElementById('systemc-status').textContent = sysOk ? 'OK' : 'Missing';
      const pathsEl = document.getElementById('systemc-paths');
      if (sysOk) { pathsEl.style.display = 'block'; pathsEl.textContent = 'INCLUDE: ' + (p.systemcInclude || 'unknown') + ' | LIBDIR: ' + (p.systemcLibdir || 'unknown'); } else { pathsEl.style.display = 'none'; }
    }

    document.getElementById('browseBtn').addEventListener('click', () => vscode.postMessage({ command: 'browseTestDirectory' }));
    document.getElementById('checkPrerequisitesBtn').addEventListener('click', () => vscode.postMessage({ command: 'checkPrerequisites' }));
    document.getElementById('compileBtn').addEventListener('click', () => vscode.postMessage({ command: 'compile' }));
    document.getElementById('runBtn').addEventListener('click', () => vscode.postMessage({ command: 'runSimulation' }));
    document.getElementById('stopBtn').addEventListener('click', () => vscode.postMessage({ command: 'stopSimulation' }));
    document.getElementById('cleanBtn').addEventListener('click', () => vscode.postMessage({ command: 'clean' }));

    document.getElementById('installVerilatorBtn').addEventListener('click', () => vscode.postMessage({ command: 'installVerilator' }));
    document.getElementById('installCppBtn').addEventListener('click', () => vscode.postMessage({ command: 'installCpp' }));
    document.getElementById('installMakeBtn').addEventListener('click', () => vscode.postMessage({ command: 'installMake' }));
    document.getElementById('installSystemCBtn').addEventListener('click', () => vscode.postMessage({ command: 'installSystemC' }));

    document.getElementById('enableWallChk').addEventListener('change', (e) => { const checked = e && e.target && e.target.checked ? true : false; vscode.postMessage({ command: 'setEnableWall', payload: checked }); });
    document.getElementById('jobsSelect').addEventListener('change', (e) => { const val = e && e.target && e.target.value !== undefined ? e.target.value : '0'; vscode.postMessage({ command: 'setJobs', payload: val }); });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'prerequisites': updatePrerequisites(message.payload); break;
        case 'updateTestDirectory': document.getElementById('testDirPath').textContent = message.payload || 'Auto-detected or click Browse...'; break;
        case 'settings':
          const s = message.payload || {}; document.getElementById('enableWallChk').checked = !!s.enableWall;
          const jobsSel = document.getElementById('jobsSelect'); const allowed = ['0','-1','1','2','4','8']; const val = String(s.jobs ?? 0); jobsSel.value = allowed.includes(val) ? val : '0';
          break;
      }
    });

    vscode.postMessage({ command: 'requestSettings' });
  </script>
</body>
</html>`;
  }
}


