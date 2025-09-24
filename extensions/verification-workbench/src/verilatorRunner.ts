/*---------------------------------------------------------------------------------------------
 *  Verilator Runner: executes Verilator compilation and simulation
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

export class VerilatorRunner implements vscode.Disposable {
	private static current: VerilatorRunner | undefined;
	private process: ChildProcess | undefined;
	private outputChannel: vscode.OutputChannel;
	private disposables: vscode.Disposable[] = [];
	private verilatorCmd: string = "verilator";

	private constructor() {
		this.outputChannel = vscode.window.createOutputChannel("Verilator");
	}

	public static getInstance(): VerilatorRunner {
		if (!VerilatorRunner.current) {
			VerilatorRunner.current = new VerilatorRunner();
		}
		return VerilatorRunner.current;
	}

	public async checkPrerequisites(): Promise<{ verilator: boolean; cppCompiler: boolean; make: boolean; systemc: boolean; systemcInclude?: string; systemcLibdir?: string }> {
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine("🔍 Checking Verilator prerequisites...");

		const prerequisites: { verilator: boolean; cppCompiler: boolean; make: boolean; systemc: boolean; systemcInclude?: string; systemcLibdir?: string } = {
			verilator: false,
			cppCompiler: false,
			make: false,
			systemc: false
		};

		// Verilator
		this.outputChannel.appendLine("Checking Verilator...");
		const cfgForVerilator = vscode.workspace.getConfiguration();
		const configuredPath = (cfgForVerilator.get<string>("verilator.verilatorPath", "") || "").trim();
		const homeDir = process.env.HOME || process.cwd();
		const candidates: string[] = [];
		if (configuredPath) candidates.push(configuredPath);
		candidates.push("verilator");
		candidates.push(path.join(homeDir, "verilator", "bin", "verilator"));
		candidates.push("/usr/local/bin/verilator");
		candidates.push("/usr/bin/verilator");
		candidates.push("/opt/homebrew/bin/verilator");

		for (const candidate of candidates) {
			const check = await this.runCommand(candidate, ["--version"]);
			if (check.success) {
				this.verilatorCmd = candidate;
				prerequisites.verilator = true;
				this.outputChannel.appendLine(`✅ Verilator found at: ${candidate}`);
				break;
			}
		}
		if (!prerequisites.verilator) {
			this.outputChannel.appendLine("❌ Verilator not found");
		}

		// C++ compiler
		this.outputChannel.appendLine("Checking C++ compiler...");
		const cfg = vscode.workspace.getConfiguration();
		const cppCompiler = cfg.get<string>("verilator.cppCompiler", "g++");
		const cppCheck = await this.runCommand(cppCompiler, ["--version"]);
		prerequisites.cppCompiler = cppCheck.success;
		this.outputChannel.appendLine(prerequisites.cppCompiler ? `✅ ${cppCompiler} found` : `❌ ${cppCompiler} not found`);

		// Make
		this.outputChannel.appendLine("Checking Make...");
		const makeCheck = await this.runCommand("make", ["--version"]);
		prerequisites.make = makeCheck.success;
		this.outputChannel.appendLine(prerequisites.make ? "✅ Make found" : "❌ Make not found");

		// SystemC
		this.outputChannel.appendLine("Checking SystemC...");
		try {
			// 0) Allow explicit overrides from settings
			const cfgSettings = vscode.workspace.getConfiguration();
			let includePath = (cfgSettings.get<string>("verilator.systemcInclude", "") || "").trim();
			let libdirPath = (cfgSettings.get<string>("verilator.systemcLibdir", "") || "").trim();

			// 1) Ask Verilator for env if not overridden
			const inc = await this.runCommand(this.verilatorCmd, ["--getenv", "SYSTEMC_INCLUDE"]);
			const lib = await this.runCommand(this.verilatorCmd, ["--getenv", "SYSTEMC_LIBDIR"]);
			if (!includePath) includePath = (inc.output || "").trim();
			if (!libdirPath) libdirPath = (lib.output || "").trim();

			// 2) If empty, check current process env (in case user exported in VS Code's terminal)
			if (!includePath && process.env.SYSTEMC_INCLUDE) includePath = process.env.SYSTEMC_INCLUDE;
			if (!libdirPath && process.env.SYSTEMC_LIBDIR) libdirPath = process.env.SYSTEMC_LIBDIR;

			// 3) Fallbacks: common system paths
			if (!includePath && fs.existsSync("/usr/include/systemc")) includePath = "/usr/include/systemc";
			// Also handle /usr/include packages that put headers directly in include
			if (!includePath && fs.existsSync("/usr/include")) {
				try { if (fs.existsSync("/usr/include/systemc.h") || fs.existsSync("/usr/include/systemc")) includePath = "/usr/include"; } catch { }
			}

			if (!libdirPath) {
				// Prefer ldconfig result if available
				const ld = await this.runCommand("/bin/bash", ["-lc", "ldconfig -p | grep systemc | awk '{print $NF}' | head -n1"]);
				const soPath = (ld.output || "").trim();
				if (soPath && fs.existsSync(soPath)) libdirPath = path.dirname(soPath);
			}
			if (!libdirPath) {
				for (const c of ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/usr/local/lib", "/usr/lib64", "/usr/lib"]) {
					try { if (fs.existsSync(c) && fs.readdirSync(c).some(n => n.toLowerCase().includes("systemc"))) { libdirPath = c; break; } } catch { }
				}
			}

			// 4) Last resort: typical $HOME builds
			if (!includePath || !libdirPath) {
				const home = process.env.HOME || process.cwd();
				try {
					const candInc = path.join(home, "systemc-2.3.3", "include");
					const candLib = path.join(home, "systemc-2.3.3", "lib-linux64");
					if (!includePath && fs.existsSync(candInc)) includePath = candInc;
					if (!libdirPath && fs.existsSync(candLib)) libdirPath = candLib;
				} catch { }
			}

			if (includePath && libdirPath) {
				prerequisites.systemc = true;
				prerequisites.systemcInclude = includePath;
				prerequisites.systemcLibdir = libdirPath;
				this.outputChannel.appendLine(`✅ SystemC found (INCLUDE=${includePath}, LIBDIR=${libdirPath})`);
			} else {
				this.outputChannel.appendLine("❌ SystemC not detected. Set SYSTEMC_INCLUDE to the directory containing systemc.h and SYSTEMC_LIBDIR to the directory containing libsystemc.a/.so");
			}
		} catch { this.outputChannel.appendLine("❌ Error detecting SystemC"); }

		this.outputChannel.appendLine("");
		if (prerequisites.verilator && prerequisites.cppCompiler && prerequisites.make && prerequisites.systemc) {
			this.outputChannel.appendLine("🎉 All prerequisites satisfied!");
		} else {
			this.outputChannel.appendLine("⚠️ Some prerequisites are missing. Please install them to use Verilator.");
		}
		return prerequisites;
	}

	public async installVerilator(): Promise<void> {
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine("📦 Installing Verilator...");
		const platform = process.platform;
		let installCommand: string; let installArgs: string[];
		switch (platform) {
			case "linux": installCommand = "sudo"; installArgs = ["apt", "update", "&&", "sudo", "apt", "install", "-y", "verilator"]; break;
			case "darwin": installCommand = "brew"; installArgs = ["install", "verilator"]; break;
			default: this.outputChannel.appendLine("❌ Automatic installation not supported on this platform."); return;
		}
		this.outputChannel.appendLine(`Running (in terminal): ${installCommand} ${installArgs.join(" ")}`);
		await this.runSudoCommandInTerminal([installCommand, ...installArgs]);
	}

	public async installSystemC(): Promise<void> {
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine("📦 SystemC manual installation required.");
		this.outputChannel.appendLine("Open the installation guide and follow the steps there.");
		this.outputChannel.appendLine("");
		this.outputChannel.appendLine("Guide link: https://gist.github.com/bagheriali2001/0736fabf7da95fb02bbe6777d53fabf7");
		try { await vscode.env.openExternal(vscode.Uri.parse("https://gist.github.com/bagheriali2001/0736fabf7da95fb02bbe6777d53fabf7")); } catch { }
		this.outputChannel.appendLine("");
		this.outputChannel.appendLine("After installing, set SYSTEMC_INCLUDE and SYSTEMC_LIBDIR for your session, then run 'Verilator: Check Prerequisites' and 'Compile'.");
	}

	public async installCppCompiler(): Promise<void> {
		const platform = process.platform;
		if (platform === "linux") {
			await this.runSudoCommandInTerminal(["sudo", "apt", "update", "&&", "sudo", "apt", "install", "-y", "g++"]);
		} else if (platform === "darwin") {
			await this.runSudoCommandInTerminal(["brew", "install", "gcc"]);
		} else {
			vscode.window.showWarningMessage("Automatic C++ compiler install not supported on this platform.");
		}
	}

	public async installMake(): Promise<void> {
		const platform = process.platform;
		if (platform === "linux") {
			await this.runSudoCommandInTerminal(["sudo", "apt", "update", "&&", "sudo", "apt", "install", "-y", "make"]);
		} else if (platform === "darwin") {
			await this.runSudoCommandInTerminal(["xcode-select", "--install"]);
		} else {
			vscode.window.showWarningMessage("Automatic Make install not supported on this platform.");
		}
	}

	private async installSystemCFromSource(): Promise<void> {
		try {
			const home = process.env.HOME || process.cwd();
			const prefix = `${home}/systemc-2.3.3-install`;
			const tarName = "systemc-2.3.3.tar.gz";
			const url = "http://accellera.org/images/downloads/standards/systemc/systemc-2.3.3.tar.gz";
			this.outputChannel.appendLine("➡️ Installing build deps (in terminal): gcc, build-essential, wget");
			await this.runSudoCommandInTerminal(["sudo", "apt", "update"]);
			await this.runSudoCommandInTerminal(["sudo", "apt", "install", "-y", "gcc", "build-essential", "wget"]);
			this.outputChannel.appendLine(`➡️ Downloading ${url}`);
			await this.runCommand("wget", ["-O", `${home}/${tarName}`, url]);
			this.outputChannel.appendLine("➡️ Extracting tarball");
			await this.runCommand("tar", ["-xvzf", `${home}/${tarName}`, "-C", home]);
			const srcDir = `${home}/systemc-2.3.3`;
			this.outputChannel.appendLine("➡️ Configuring SystemC (prefix in home)");
			await this.runCommand("mkdir", ["-p", `${srcDir}/objdir`]);
			let result = await this.runCommand("/bin/bash", ["-lc", `cd ${srcDir}/objdir && export CXX=g++ && ../configure --prefix=${prefix}`]);
			if (!result.success) throw new Error("configure failed");
			this.outputChannel.appendLine("➡️ Building SystemC");
			result = await this.runCommand("/bin/bash", ["-lc", `cd ${srcDir}/objdir && make -j`]);
			if (!result.success) throw new Error("make failed");
			this.outputChannel.appendLine("➡️ Installing to prefix");
			result = await this.runCommand("/bin/bash", ["-lc", `cd ${srcDir}/objdir && make install`]);
			if (!result.success) throw new Error("make install failed");
			const includePath = `${prefix}/include`;
			let libdirPath = `${prefix}/lib`;
			try { if (fs.existsSync(`${prefix}/lib-linux64`)) libdirPath = `${prefix}/lib-linux64`; } catch { }
			process.env.SYSTEMC_INCLUDE = includePath;
			process.env.SYSTEMC_LIBDIR = libdirPath;
			this.outputChannel.appendLine(`✅ SystemC built and installed at:\n  INCLUDE: ${includePath}\n  LIBDIR: ${libdirPath}`);
			this.outputChannel.appendLine("To persist for new terminals, add to ~/.bashrc:");
			this.outputChannel.appendLine(`  export SYSTEMC_INCLUDE=${includePath}`);
			this.outputChannel.appendLine(`  export SYSTEMC_LIBDIR=${libdirPath}`);
			await this.checkPrerequisites();
		} catch (e: any) {
			this.outputChannel.appendLine(`❌ Source build failed: ${e.message}`);
		}
	}

	private async installSystemCFromSourceCMake(version: string, installPrefix: string): Promise<void> {
		try {
			const home = process.env.HOME || process.cwd();
			const url = `https://accellera.org/images/downloads/standards/systemc/systemc-${version}.tar.gz`;
			const srcTar = `${home}/Downloads/systemc-${version}.tar.gz`;
			const srcDir = `${home}/Downloads/systemc-${version}`;
			const buildDir = `${srcDir}/objdir`;

			this.outputChannel.appendLine("➡️ Installing deps (cmake, build-essential, gcc, wget) in terminal");
			await this.runSudoCommandInTerminal(["sudo", "apt", "update"]);
			await this.runSudoCommandInTerminal(["sudo", "apt", "install", "-y", "cmake", "build-essential", "gcc", "wget"]);

			this.outputChannel.appendLine(`➡️ Downloading ${url}`);
			await this.runCommand("/bin/bash", ["-lc", `mkdir -p ${home}/Downloads && wget -O ${srcTar} ${url}`]);

			this.outputChannel.appendLine("➡️ Extracting");
			await this.runCommand("/bin/bash", ["-lc", `mkdir -p ${srcDir} && tar -xzf ${srcTar} -C ${srcDir} --strip-components=1`]);

			this.outputChannel.appendLine("➡️ Configuring with CMake");
			await this.runCommand("/bin/bash", ["-lc", `mkdir -p ${buildDir} && cd ${buildDir} && cmake .. -DCMAKE_INSTALL_PREFIX=${installPrefix} -DCMAKE_CXX_STANDARD=14`]);

			this.outputChannel.appendLine("➡️ Building");
			await this.runCommand("/bin/bash", ["-lc", `cd ${buildDir} && make -j`]);

			this.outputChannel.appendLine("➡️ Installing (sudo)");
			await this.runSudoCommandInTerminal(["/bin/bash", "-lc", `cd ${buildDir} && sudo make install`]);

			const includePath = `${installPrefix}/include`;
			let libdirPath = `${installPrefix}/lib-linux64`;
			if (!fs.existsSync(libdirPath)) {
				const alt = `${installPrefix}/lib`;
				if (fs.existsSync(alt)) libdirPath = alt;
			}
			process.env.SYSTEMC_INCLUDE = includePath;
			process.env.SYSTEMC_LIBDIR = libdirPath;
			this.outputChannel.appendLine(`✅ SystemC installed at:\n  INCLUDE: ${includePath}\n  LIBDIR: ${libdirPath}`);
			this.outputChannel.appendLine("To persist for new terminals, add to ~/.bashrc:");
			this.outputChannel.appendLine(`  export SYSTEMC_INCLUDE=${includePath}`);
			this.outputChannel.appendLine(`  export SYSTEMC_LIBDIR=${libdirPath}`);
		} catch (e: any) {
			this.outputChannel.appendLine(`❌ CMake source install failed: ${e.message}`);
		}
	}

	public async compile(testPath?: string): Promise<void> {
		if (this.process) { vscode.window.showWarningMessage("Verilator compilation is already running. Stop it first."); return; }
		const prerequisites = await this.checkPrerequisites();
		if (!prerequisites.verilator) { vscode.window.showErrorMessage("Verilator is not installed."); return; }

		const cfg = vscode.workspace.getConfiguration();
		const testDir = cfg.get<string>("verilator.testDirectory", "");
		const targetDir = await this.getTestDirectory(testDir, testPath);
		if (!targetDir) return;

		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine(`🔨 Compiling Verilator design in: ${targetDir}`);

		const verilogFiles = await this.findVerilogFiles(targetDir);
		if (verilogFiles.length === 0) { vscode.window.showErrorMessage("No Verilog files found in the test directory."); return; }
		this.outputChannel.appendLine(`Found Verilog files: ${verilogFiles.map(f => path.basename(f)).join(", ")}`);

		const isSystemC = await this.detectSystemC(targetDir);
		const enableWall = cfg.get<boolean>("verilator.enableWall", true);
		const jobs = cfg.get<number>("verilator.jobs", 0);

		let verilatorArgs: string[];
		if (isSystemC) {
			this.outputChannel.appendLine("🔍 Detected SystemC example");
			verilatorArgs = ["--sc", "--exe", "--build", ...verilogFiles];
		} else {
			this.outputChannel.appendLine("🔍 Detected C++ example");
			verilatorArgs = ["--cc", "--exe", "--build", "--trace", ...verilogFiles];
		}
		if (enableWall) verilatorArgs.unshift("-Wall");
		if (jobs !== -1) { verilatorArgs.splice(3, 0, "-j"); if (jobs > 0) verilatorArgs.splice(4, 0, String(jobs)); }

		const testbenchFiles = await this.findTestbenchFiles(targetDir);
		if (testbenchFiles.length > 0) {
			verilatorArgs.push(...testbenchFiles);
			this.outputChannel.appendLine(`Found testbench files: ${testbenchFiles.map(f => path.basename(f)).join(", ")}`);
		}

		this.outputChannel.appendLine(`Running: ${this.verilatorCmd} ${verilatorArgs.join(" ")}`);
		const compileEnv: NodeJS.ProcessEnv = { ...process.env };
		if (prerequisites.systemcInclude) compileEnv.SYSTEMC_INCLUDE = prerequisites.systemcInclude;
		if (prerequisites.systemcLibdir) compileEnv.SYSTEMC_LIBDIR = prerequisites.systemcLibdir;

		this.process = spawn(this.verilatorCmd, verilatorArgs, { cwd: targetDir, stdio: ["pipe", "pipe", "pipe"], env: compileEnv });
		this.process.stdout?.on("data", (d: Buffer) => this.outputChannel.append(d.toString()));
		this.process.stderr?.on("data", (d: Buffer) => this.outputChannel.append(d.toString()));
		this.process.on("close", (code: number | null) => {
			this.process = undefined;
			if (code === 0) { this.outputChannel.appendLine("✅ Verilator compilation completed successfully!"); vscode.window.showInformationMessage("Verilator compilation completed successfully!"); }
			else { this.outputChannel.appendLine(`❌ Verilator compilation failed with exit code: ${code}`); vscode.window.showErrorMessage(`Verilator compilation failed with exit code: ${code}`); }
		});
		this.process.on("error", (err: Error) => { this.process = undefined; this.outputChannel.appendLine(`❌ Error running Verilator: ${err.message}`); });
	}

	public async runSimulation(testPath?: string): Promise<void> {
		const cfg = vscode.workspace.getConfiguration();
		const targetDir = await this.getTestDirectory(cfg.get<string>("verilator.testDirectory", ""), testPath);
		if (!targetDir) return;
		this.outputChannel.clear(); this.outputChannel.show();
		this.outputChannel.appendLine(`🚀 Running Verilator simulation in: ${targetDir}`);
		const executable = await this.findExecutable(targetDir);
		if (!executable) {
			this.outputChannel.appendLine("❌ No Verilator executable found. Compile first.");
			try { const mainEntries = fs.readdirSync(targetDir); this.outputChannel.appendLine(`- Main directory contents: ${mainEntries.join(", ")}`); } catch { }
			vscode.window.showErrorMessage("No Verilator executable found. Compile first.");
			return;
		}
		this.outputChannel.appendLine(`Found executable: ${path.basename(executable)}`);
		this.process = spawn(executable, [], { cwd: targetDir, stdio: ["pipe", "pipe", "pipe"] });
		this.process.stdout?.on("data", (d: Buffer) => this.outputChannel.append(d.toString()));
		this.process.stderr?.on("data", (d: Buffer) => this.outputChannel.append(d.toString()));
		this.process.on("close", (code: number | null) => { this.process = undefined; if (code === 0) { this.outputChannel.appendLine("✅ Verilator simulation completed successfully!"); } else { this.outputChannel.appendLine(`❌ Verilator simulation failed with exit code: ${code}`); } });
	}

	public async stopSimulation(): Promise<void> {
		if (this.process) {
			this.process.kill();
			this.process = undefined;
			this.outputChannel.appendLine("⏹️ Verilator process stopped");
			vscode.window.showInformationMessage("Verilator process stopped");
		} else {
			vscode.window.showWarningMessage("No Verilator process is currently running.");
		}
	}

	public async clean(testPath?: string): Promise<void> {
		const cfg = vscode.workspace.getConfiguration();
		const targetDir = await this.getTestDirectory(cfg.get<string>("verilator.testDirectory", ""), testPath);
		if (!targetDir) return;
		this.outputChannel.clear(); this.outputChannel.show();
		this.outputChannel.appendLine(`🧹 Cleaning Verilator files in: ${targetDir}`);
		try { const objDir = path.join(targetDir, "obj_dir"); if (fs.existsSync(objDir)) { fs.rmSync(objDir, { recursive: true, force: true }); this.outputChannel.appendLine("Removed directory: obj_dir"); } } catch { }
		vscode.window.showInformationMessage("Verilator cleanup completed!");
	}

	public async setTestDirectory(): Promise<void> {
		const options: vscode.OpenDialogOptions = { canSelectMany: false, openLabel: "Select Test Directory", canSelectFolders: true, canSelectFiles: false };
		const folderUri = await vscode.window.showOpenDialog(options);
		if (folderUri && folderUri[0]) { const cfg = vscode.workspace.getConfiguration(); await cfg.update("verilator.testDirectory", folderUri[0].fsPath, vscode.ConfigurationTarget.Workspace); vscode.window.showInformationMessage(`Verilator test directory set to: ${folderUri[0].fsPath}`); }
	}

	private async getTestDirectory(configuredDir: string, testPath?: string): Promise<string | undefined> {
		if (configuredDir) return configuredDir;
		if (testPath) return path.dirname(testPath);
		const options: vscode.OpenDialogOptions = { canSelectMany: false, openLabel: "Select Test Directory", canSelectFolders: true, canSelectFiles: false };
		const folderUri = await vscode.window.showOpenDialog(options);
		return folderUri && folderUri[0] ? folderUri[0].fsPath : undefined;
	}

	private async findVerilogFiles(directory: string): Promise<string[]> {
		const verilogFiles: string[] = [];
		try { const entries = fs.readdirSync(directory, { withFileTypes: true }); for (const entry of entries) { if (entry.isFile() && (entry.name.endsWith('.v') || entry.name.endsWith('.sv') || entry.name.endsWith('.verilog'))) { verilogFiles.push(path.join(directory, entry.name)); } } } catch { }
		return verilogFiles;
	}

	private async findTestbenchFiles(directory: string): Promise<string[]> {
		const tb: string[] = [];
		try { const entries = fs.readdirSync(directory, { withFileTypes: true }); for (const entry of entries) { if (entry.isFile() && (entry.name.endsWith('.cpp') || entry.name.endsWith('.cc') || entry.name.endsWith('.cxx'))) { tb.push(path.join(directory, entry.name)); } } } catch { }
		return tb;
	}

	private async detectSystemC(directory: string): Promise<boolean> {
		try { const entries = fs.readdirSync(directory, { withFileTypes: true }); for (const entry of entries) { if (entry.isFile() && (entry.name.endsWith('.cpp') || entry.name.endsWith('.cc') || entry.name.endsWith('.cxx'))) { const content = fs.readFileSync(path.join(directory, entry.name), 'utf8'); if (content.includes('sc_main') || content.includes('#include <systemc.h>') || content.includes('sc_module')) { return true; } } } } catch { }
		return false;
	}

	private async findExecutable(directory: string): Promise<string | undefined> {
		try {
			const objDir = path.join(directory, "obj_dir");
			if (fs.existsSync(objDir)) { const entries = fs.readdirSync(objDir, { withFileTypes: true }); for (const e of entries) { if (e.isFile() && e.name.startsWith("V") && !e.name.includes(".")) { const full = path.join(objDir, e.name); try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { } } } }
			const entries = fs.readdirSync(directory, { withFileTypes: true });
			for (const e of entries) { if (e.isFile() && e.name.startsWith("V") && !e.name.includes(".")) { const full = path.join(directory, e.name); try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { } } }
		} catch { }
		return undefined;
	}

	private async runCommand(command: string, args: string[]): Promise<{ success: boolean; output: string; error: string }> {
		return new Promise((resolve) => {
			const p = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
			let output = ""; let error = "";
			p.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
			p.stderr?.on("data", (d: Buffer) => { error += d.toString(); });
			p.on("close", (code: number | null) => resolve({ success: code === 0, output, error }));
			p.on("error", (err: Error) => resolve({ success: false, output, error: err.message }));
		});
	}

	private async runSudoCommandInTerminal(installCommand: string[]): Promise<boolean> {
		try {
			let terminal = vscode.window.terminals.find(t => t.name === "Chip Tools Install");
			if (!terminal) {
				terminal = vscode.window.createTerminal({ name: "Chip Tools Install", cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd() });
			}
			terminal.show(true);
			const cmd = installCommand.join(" ");
			terminal.sendText(cmd, true);
			this.outputChannel.appendLine(`✅ Command sent to terminal: ${cmd}`);
			this.outputChannel.appendLine("🔐 Sudo may be required. When prompted, enter your password in the integrated terminal.");
			vscode.window.showInformationMessage("Sudo operation started. When prompted, enter your password in the terminal.");
			return true;
		} catch (error: any) {
			this.outputChannel.appendLine(`❌ Error opening terminal: ${error.message}`);
			vscode.window.showErrorMessage(`Error opening terminal: ${error.message}`);
			return false;
		}
	}

	public isRunning(): boolean { return this.process !== undefined && !this.process.killed; }
	public dispose(): void { if (this.process) { this.process.kill(); } this.disposables.forEach(d => d.dispose()); }
}


