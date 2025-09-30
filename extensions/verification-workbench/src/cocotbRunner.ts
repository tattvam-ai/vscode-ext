/*---------------------------------------------------------------------------------------------
 *  Cocotb Runner: executes cocotb tests and manages output
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

export class CocotbRunner implements vscode.Disposable {
	private static current: CocotbRunner | undefined;
	private process: ChildProcess | undefined;
	private outputChannel: vscode.OutputChannel;
	private disposables: vscode.Disposable[] = [];

	private constructor() {
		this.outputChannel = vscode.window.createOutputChannel("Cocotb Tests");
	}

	public static getInstance(): CocotbRunner {
		if (!CocotbRunner.current) {
			CocotbRunner.current = new CocotbRunner();
		}
		return CocotbRunner.current;
	}

	public async runTests(testPath?: string): Promise<void> {
		if (this.process) {
			vscode.window.showWarningMessage("Cocotb tests are already running. Stop them first.");
			return;
		}

		// Check prerequisites and offer to install if missing
		const prerequisites = await this.checkPrerequisites();
		if (!prerequisites.python) {
			vscode.window.showErrorMessage("Python3 is not installed. Please install Python3 first.");
			return;
		}

		if (!prerequisites.cocotb) {
			const cfg = vscode.workspace.getConfiguration();
			const autoSetup = cfg.get<boolean>("cocotb.autoSetup", true);

			if (autoSetup) {
				const install = await vscode.window.showWarningMessage(
					"Cocotb is not installed. Would you like to install it automatically?",
					"Install Cocotb",
					"Cancel"
				);

				if (install === "Install Cocotb") {
					const success = await this.installCocotb();
					if (!success) {
						return; // Installation failed
					}
				} else {
					return; // User cancelled
				}
			} else {
				vscode.window.showErrorMessage("Cocotb is not installed. Please install it manually: pip install 'cocotb~=2.0'");
				return;
			}
		}

		if (!prerequisites.icarus) {
			const install = await vscode.window.showWarningMessage(
				"Icarus Verilog (iverilog) is not installed. Would you like to install it automatically?",
				"Install Simulator",
				"Cancel"
			);

			if (install === "Install Simulator") {
				const success = await this.installSimulator();
				if (!success) {
					return; // Installation failed
				}
			} else {
				return; // User cancelled
			}
		}

		const cfg = vscode.workspace.getConfiguration();
		const simulator = cfg.get<string>("cocotb.simulator.type", "iverilog");
		const simulatorPath = cfg.get<string>("cocotb.simulator.path", "");
		const pythonPath = cfg.get<string>("cocotb.python.path", "");
		const testDir = cfg.get<string>("cocotb.testDirectory", "");

		// Step 1: Determine test directory (where Makefile should be)
		let targetDir = await this.getTestDirectory(testDir, testPath);
		if (!targetDir) {
			return; // User cancelled
		}

		// Check if Makefile exists
		const makefilePath = path.join(targetDir, "Makefile");
		if (!fs.existsSync(makefilePath)) {
			const generate = await vscode.window.showInformationMessage(
				`No Makefile found in ${targetDir}. Would you like to generate a basic Makefile for cocotb?`,
				"Generate Makefile",
				"Cancel"
			);

			if (generate === "Generate Makefile") {
				// Use the existing generateMakefile command
				await vscode.commands.executeCommand("cocotb.generateMakefile");
				return; // Exit so user can configure and try again
			} else {
				return; // User cancelled
			}
		}

		this.outputChannel.appendLine(`Using existing Makefile: ${makefilePath}`);

		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine(`Running cocotb tests in: ${targetDir}`);
		this.outputChannel.appendLine(`Simulator: ${simulator}`);
		this.outputChannel.appendLine("");

		// Build environment variables - ensure we use the correct Python environment
		const env = { ...process.env };
		if (simulatorPath) {
			env.PATH = `${simulatorPath}:${env.PATH}`;
		}
		if (pythonPath) {
			env.PYTHONPATH = pythonPath;
		}

		// If we're using the extension's virtual environment, update PATH and PYTHON
		const config = vscode.workspace.getConfiguration();
		const configuredPythonPath = config.get<string>("cocotb.python.path", "");
		if (configuredPythonPath && configuredPythonPath.includes(".cocotb-env")) {
			// Using extension's virtual environment
			const venvBinDir = path.dirname(configuredPythonPath);
			env.PATH = `${venvBinDir}:${env.PATH}`;
			env.PYTHON = configuredPythonPath;
			this.outputChannel.appendLine(`Using virtual environment: ${venvBinDir}`);
		}

		// Set cocotb-specific environment variables
		// Note: cocotb uses "icarus" for Icarus Verilog, not "iverilog"
		if (simulator === "iverilog") {
			env.SIM = "icarus";
			env.IVERILOG = simulatorPath || "iverilog";
		} else {
			env.SIM = simulator;
		}

		// Check for virtual environment and activate it
		const discoveredVenv = await this.findVirtualEnvironment(targetDir);
		let command = "make";
		let args: string[] = [];

		if (discoveredVenv && !process.env.VIRTUAL_ENV) {
			// Found a virtual environment that's not currently active
			this.outputChannel.appendLine(`🔄 Activating virtual environment: ${discoveredVenv}`);

			// Set up environment variables for the virtual environment
			env.VIRTUAL_ENV = discoveredVenv;
			env.PATH = `${path.join(discoveredVenv, 'bin')}:${env.PATH}`;

			// Use bash to activate the virtual environment and run make
			command = "bash";
			args = ["-c", `source ${path.join(discoveredVenv, 'bin', 'activate')} && make sim`];
		} else {
			// Use make directly (either no venv found or already active)
			args = ["sim"];
		}

		// Start process
		this.process = spawn(command, args, {
			cwd: targetDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: env
		});

		// Stream output
		if (this.process.stdout) {
			this.process.stdout.on("data", (data: Buffer) => {
				this.outputChannel.append(data.toString());
			});
		}

		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => {
				this.outputChannel.append(data.toString());
			});
		}

		this.process.on("close", (code: number | null) => {
			this.outputChannel.appendLine("");
			if (code === 0) {
				this.outputChannel.appendLine("✅ Cocotb tests completed successfully!");
				vscode.window.showInformationMessage("Cocotb tests completed successfully!");
			} else {
				this.outputChannel.appendLine(`❌ Cocotb tests failed with exit code: ${code}`);
				vscode.window.showErrorMessage(`Cocotb tests failed with exit code: ${code}`);
			}

			// Auto-open waveform in GTKWave if enabled
			try {
				const cfg = vscode.workspace.getConfiguration();
				const autoOpen = cfg.get<boolean>("cocotb.autoOpenWaveform", true);
				if (autoOpen) {
					// Defer slightly to allow filesystem to flush waveform files
					setTimeout(() => {
						this.viewWaveforms().catch(() => { /* Best-effort */ });
					}, 800);
				}
			} catch { }

			this.process = undefined;
		});

		this.process.on("error", (error: Error) => {
			this.outputChannel.appendLine(`❌ Error: ${error.message}`);
			vscode.window.showErrorMessage(`Cocotb test error: ${error.message}`);
			this.process = undefined;
		});

		vscode.window.showInformationMessage("Cocotb tests started. Check the output channel for progress.");
	}

	public async cleanTests(): Promise<void> {
		if (this.process) {
			vscode.window.showWarningMessage("Cocotb tests are running. Stop them before cleaning.");
			return;
		}

		// Use the same directory detection logic as runTests
		const cfg = vscode.workspace.getConfiguration();
		const testDir = cfg.get<string>("cocotb.testDirectory", "");
		const testPath = vscode.window.activeTextEditor?.document.uri.fsPath;

		// Step 1: Determine test directory (same as runTests)
		let targetDir = await this.getTestDirectory(testDir, testPath);
		if (!targetDir) {
			return; // User cancelled
		}

		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine(`Cleaning cocotb test artifacts in: ${targetDir}`);
		this.outputChannel.appendLine("");

		// Use the same environment setup as runTests
		const simulator = cfg.get<string>("cocotb.simulator.type", "iverilog");
		const simulatorPath = cfg.get<string>("cocotb.simulator.path", "");
		const pythonPath = cfg.get<string>("cocotb.python.path", "");

		// Build environment variables - same as runTests
		const env = { ...process.env };
		if (simulatorPath) {
			env.PATH = `${simulatorPath}:${env.PATH}`;
		}
		if (pythonPath) {
			env.PYTHONPATH = pythonPath;
		}

		// If we're using the extension's virtual environment, update PATH and PYTHON
		const configuredPythonPath = cfg.get<string>("cocotb.python.path", "");
		if (configuredPythonPath && configuredPythonPath.includes(".cocotb-env")) {
			// Using extension's virtual environment
			const venvBinDir = path.dirname(configuredPythonPath);
			env.PATH = `${venvBinDir}:${env.PATH}`;
			env.PYTHON = configuredPythonPath;
			this.outputChannel.appendLine(`Using virtual environment: ${venvBinDir}`);
		}

		// Set cocotb-specific environment variables
		if (simulator === "iverilog") {
			env.SIM = "icarus";
			env.IVERILOG = simulatorPath || "iverilog";
		} else {
			env.SIM = simulator;
		}

		// Check for virtual environment and activate it
		const discoveredVenv = await this.findVirtualEnvironment(targetDir);
		let command = "make";
		let args: string[] = [];

		if (discoveredVenv && !process.env.VIRTUAL_ENV) {
			// Found a virtual environment that's not currently active
			this.outputChannel.appendLine(`🔄 Activating virtual environment for clean: ${discoveredVenv}`);

			// Set up environment variables for the virtual environment
			env.VIRTUAL_ENV = discoveredVenv;
			env.PATH = `${path.join(discoveredVenv, 'bin')}:${env.PATH}`;

			// Use bash to activate the virtual environment and run make clean
			command = "bash";
			args = ["-c", `source ${path.join(discoveredVenv, 'bin', 'activate')} && make clean`];
		} else {
			// Use make directly (either no venv found or already active)
			args = ["clean"];
		}

		this.process = spawn(command, args, {
			cwd: targetDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: env
		});

		if (this.process.stdout) {
			this.process.stdout.on("data", (data: Buffer) => this.outputChannel.append(data.toString()));
		}
		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => this.outputChannel.append(data.toString()));
		}

		this.process.on("close", (code: number | null) => {
			this.outputChannel.appendLine("");
			if (code === 0) {
				this.outputChannel.appendLine("🧹 Cleaned cocotb test artifacts.");
				vscode.window.showInformationMessage("Cocotb: clean completed.");

				// Notify sidebar of cleaned status
				const { CocotbSidebar } = require('./cocotbSidebar');
				const sidebar = CocotbSidebar.getInstance();
				if (sidebar) {
					sidebar.postStatus('cleaned');
				}
			} else {
				this.outputChannel.appendLine(`❌ clean failed with exit code: ${code}`);
				vscode.window.showErrorMessage(`Cocotb: clean failed with exit code: ${code}`);
			}
			this.process = undefined;
		});

		this.process.on("error", (error: Error) => {
			this.outputChannel.appendLine(`❌ Error: ${error.message}`);
			vscode.window.showErrorMessage(`Cocotb clean error: ${error.message}`);
			this.process = undefined;
		});
	}

	public async generateMakefile(testDir: string, designFile: string, testFile: string): Promise<void> {
		const designBasename = path.basename(designFile, path.extname(designFile));
		const testBasename = path.basename(testFile, path.extname(testFile));

		const makefileContent = `# Makefile for cocotb test

TOPLEVEL = ${designBasename}
MODULE = ${testBasename}

# Use icarus (Icarus Verilog) as default simulator
SIM = icarus

# Enable waveform dumping for Icarus Verilog
WAVES = 1

# Include cocotb makefile
include \$(shell cocotb-config --makefiles)/Makefile.sim

# Design files
VERILOG_SOURCES = ${designFile}

# Test files
TOPLEVEL_LANG = verilog
PYTHONPATH = .
`;

		const makefilePath = path.join(testDir, "Makefile");
		fs.writeFileSync(makefilePath, makefileContent);
		vscode.window.showInformationMessage(`Generated Makefile at: ${makefilePath}`);
	}

	public async checkPrerequisites(): Promise<{ cocotb: boolean; icarus: boolean; verilator: boolean; python: boolean; gtkwave: boolean }> {
		const results = { cocotb: false, icarus: false, verilator: false, python: false, gtkwave: false };

		// Debug: Show environment info
		this.outputChannel.appendLine("🔍 Environment Debug Info:");
		this.outputChannel.appendLine(`VIRTUAL_ENV: ${process.env.VIRTUAL_ENV || "Not set"}`);
		this.outputChannel.appendLine(`PATH: ${process.env.PATH?.substring(0, 200)}...`);
		this.outputChannel.appendLine("");

		// Check cocotb in priority order: manual config > active venv > discovered venv > system-wide
		const cfg = vscode.workspace.getConfiguration();
		const manualPythonPath = cfg.get<string>("cocotb.python.path", "");

		let pythonToCheck: string[];

		if (manualPythonPath) {
			// User manually configured Python path
			pythonToCheck = [manualPythonPath];
			this.outputChannel.appendLine(`Using manually configured Python: ${manualPythonPath}`);
		} else if (process.env.VIRTUAL_ENV) {
			// Virtual environment is active - check it first, then system
			const venvPython = path.join(process.env.VIRTUAL_ENV, "bin", "python");
			pythonToCheck = [venvPython, "python3", "python"];
			this.outputChannel.appendLine(`Virtual environment detected: ${process.env.VIRTUAL_ENV}`);
			this.outputChannel.appendLine(`Will check: venv python, then system python`);
		} else {
			// Search for virtual environments in current directory and parents
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
			const discoveredVenv = await this.findVirtualEnvironment(workspaceRoot);

			if (discoveredVenv) {
				const venvPython = path.join(discoveredVenv, "bin", "python");
				pythonToCheck = [venvPython, "python3", "python"];
				this.outputChannel.appendLine(`Discovered virtual environment: ${discoveredVenv}`);
				this.outputChannel.appendLine(`Will check: discovered venv python, then system python`);
			} else {
				// No virtual environment - check system-wide
				pythonToCheck = ["python3", "python"];
				this.outputChannel.appendLine(`No virtual environment detected, checking system python`);
			}
		}

		// Check each Python in order until we find one that works
		let workingPython = "";
		for (const pythonCmd of pythonToCheck) {
			this.outputChannel.appendLine(`\nTesting Python: ${pythonCmd}`);

			try {
				// Check if Python exists and works
				const pythonResult = await this.runCommand(pythonCmd, ["--version"]);
				if (pythonResult.success) {
					this.outputChannel.appendLine(`  ✅ Python found: ${pythonResult.output.trim()}`);
					results.python = true;

					// Check if this Python has cocotb
					this.outputChannel.appendLine(`  Checking cocotb with: ${pythonCmd} -c "import cocotb; print('cocotb available')"`);
					const cocotbResult = await this.runCommand(pythonCmd, ["-c", "import cocotb; print('cocotb available')"]);

					if (cocotbResult.success) {
						this.outputChannel.appendLine(`  ✅ Cocotb found: ${cocotbResult.output.trim()}`);
						results.cocotb = true;
						workingPython = pythonCmd;
						break; // Found working Python with cocotb
					} else {
						this.outputChannel.appendLine(`  ❌ Cocotb not found: ${cocotbResult.error}`);
					}
				} else {
					this.outputChannel.appendLine(`  ❌ Python not working: ${pythonResult.error}`);
				}
			} catch (err: any) {
				this.outputChannel.appendLine(`  ❌ Python check exception: ${err.message}`);
			}
		}

		if (workingPython) {
			this.outputChannel.appendLine(`\n✅ Using Python: ${workingPython}`);
		} else {
			this.outputChannel.appendLine(`\n❌ No working Python with cocotb found`);
		}

		try {
			// Check Icarus Verilog (iverilog)
			this.outputChannel.appendLine(`\nChecking Icarus (iverilog)...`);
			const cfg = vscode.workspace.getConfiguration();
			const iverilogCmd = cfg.get<string>("cocotb.simulator.path", "iverilog") || "iverilog";
			this.outputChannel.appendLine(`Testing: ${iverilogCmd} -v`);
			let icarusResult = await this.runCommand(iverilogCmd, ["-v"]);
			this.outputChannel.appendLine(`Result: success=${icarusResult.success}, output="${icarusResult.output}", error="${icarusResult.error}"`);

			if (!icarusResult.success) {
				this.outputChannel.appendLine(`Primary command failed, trying alternatives...`);
				const alternativeNames = ["iverilog", "iverilog-gtk", "iverilog-vpi"];
				for (const altName of alternativeNames) {
					this.outputChannel.appendLine(`  Testing: ${altName} -v`);
					icarusResult = await this.runCommand(altName, ["-v"]);
					this.outputChannel.appendLine(`  Result: success=${icarusResult.success}, output="${icarusResult.output}", error="${icarusResult.error}"`);
					if (icarusResult.success) {
						this.outputChannel.appendLine(`  ✅ Found working iverilog: ${altName}`);
						await cfg.update("cocotb.simulator.path", altName, vscode.ConfigurationTarget.Workspace);
						break;
					}
				}
			}

			results.icarus = icarusResult.success;
			this.outputChannel.appendLine(icarusResult.success ? `✅ Icarus detected successfully` : `❌ Icarus (iverilog) not found`);
		} catch (err: any) {
			this.outputChannel.appendLine(`❌ Icarus check exception: ${err.message}`);
			results.icarus = false;
		}

		// Check Verilator (optional for cocotb, but useful)
		try {
			this.outputChannel.appendLine(`\nChecking Verilator...`);
			const verilatorResult = await this.runCommand("verilator", ["--version"]);
			results.verilator = verilatorResult.success;
			this.outputChannel.appendLine(verilatorResult.success ? `✅ Verilator detected` : `❌ Verilator not found`);
		} catch (err: any) {
			this.outputChannel.appendLine(`❌ Verilator check exception: ${err.message}`);
			results.verilator = false;
		}

		// Check GTKWave
		try {
			this.outputChannel.appendLine(`\nChecking GTKWave...`);
			const gtkwaveResult = await this.runCommand("gtkwave", ["--version"]);

			if (gtkwaveResult.success) {
				this.outputChannel.appendLine(`✅ GTKWave detected: ${gtkwaveResult.output.split('\n')[0]}`);
				results.gtkwave = true;
			} else {
				this.outputChannel.appendLine(`❌ GTKWave not found`);
				results.gtkwave = false;
			}
		} catch (err: any) {
			this.outputChannel.appendLine(`❌ GTKWave check exception: ${err.message}`);
			results.gtkwave = false;
		}

		return results;
	}

	private async findVirtualEnvironment(startDir: string): Promise<string | null> {
		// Common virtual environment directory names
		const venvNames = ['.venv', 'venv', 'env', '.env', 'cocotb-env', '.cocotb-env'];

		let currentDir = startDir;
		const maxDepth = 5; // Prevent infinite loops
		let depth = 0;

		while (currentDir && depth < maxDepth) {
			// Check for virtual environment directories in current directory
			for (const venvName of venvNames) {
				const venvPath = path.join(currentDir, venvName);
				const pythonPath = path.join(venvPath, 'bin', 'python');

				if (fs.existsSync(pythonPath)) {
					this.outputChannel.appendLine(`🔍 Found virtual environment: ${venvPath}`);
					return venvPath;
				}
			}

			// Move to parent directory
			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir) {
				break; // Reached root directory
			}
			currentDir = parentDir;
			depth++;
		}

		return null;
	}

	private async findBestPython(): Promise<string> {
		// First check if user has manually specified a Python path
		const cfg = vscode.workspace.getConfiguration();
		const manualPythonPath = cfg.get<string>("cocotb.python.path", "");
		if (manualPythonPath) {
			// Test if this Python has cocotb
			try {
				const testResult = await this.runCommand(manualPythonPath, ["-c", "import cocotb; print('cocotb available')"]);
				if (testResult.success) {
					return manualPythonPath;
				}
			} catch {
				// Continue with auto-detection
			}
		}

		// Check if we're in a virtual environment
		if (process.env.VIRTUAL_ENV) {
			// We're in a virtual environment, use its Python
			return path.join(process.env.VIRTUAL_ENV, "bin", "python");
		}

		// Check for common virtual environment indicators
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			for (const folder of workspaceFolders) {
				// Look for common virtual environment directories
				const venvPaths = [
					path.join(folder.uri.fsPath, ".cocotb-env", "bin", "python"), // Extension-created venv (highest priority)
					path.join(folder.uri.fsPath, "venv", "bin", "python"),
					path.join(folder.uri.fsPath, ".venv", "bin", "python"),
					path.join(folder.uri.fsPath, "env", "bin", "python"),
					path.join(folder.uri.fsPath, ".env", "bin", "python"),
					path.join(folder.uri.fsPath, "cocotb-env", "bin", "python")
				];

				for (const venvPath of venvPaths) {
					if (fs.existsSync(venvPath)) {
						// Test if this Python has cocotb
						try {
							const testResult = await this.runCommand(venvPath, ["-c", "import cocotb; print('cocotb available')"]);
							if (testResult.success) {
								return venvPath;
							}
						} catch {
							// Continue checking other paths
						}
					}
				}
			}
		}

		// Fall back to system Python
		return "python3";
	}

	private async findExistingVirtualEnvironments(workspacePath: string): Promise<string[]> {
		const venvDirs = [
			"venv",
			".venv",
			"env",
			".env",
			"cocotb-env",
			".cocotb-env"
		];

		const existingVenvs: string[] = [];

		for (const venvDir of venvDirs) {
			const venvPath = path.join(workspacePath, venvDir);
			const pythonPath = path.join(venvPath, "bin", "python");

			if (fs.existsSync(pythonPath)) {
				existingVenvs.push(venvPath);
			}
		}

		return existingVenvs;
	}

	public async installCocotb(): Promise<boolean> {
		const cfg = vscode.workspace.getConfiguration();
		const autoSetup = cfg.get<boolean>("cocotb.autoSetup", true);

		if (!autoSetup) {
			vscode.window.showInformationMessage("Cocotb auto-setup is disabled. Please install cocotb manually: pip install 'cocotb~=2.0'");
			return false;
		}

		// Check if Python is available first
		const pythonResult = await this.runCommand("python3", ["--version"]);
		if (!pythonResult.success) {
			vscode.window.showErrorMessage("Python3 is not available. Please install Python3 first.");
			return false;
		}

		// Show progress
		const progressMessage = vscode.window.showInformationMessage("Installing cocotb... This may take a few minutes.", "Cancel");

		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine("Installing cocotb...");
		this.outputChannel.appendLine("");

		try {
			// First, check if we're in a virtual environment (from terminal)
			if (process.env.VIRTUAL_ENV) {
				this.outputChannel.appendLine(`Detected active virtual environment: ${process.env.VIRTUAL_ENV}`);
				this.outputChannel.appendLine("Attempting to install cocotb in current virtual environment...");

				const venvPip = path.join(process.env.VIRTUAL_ENV, "bin", "pip");
				const installResult = await this.runCommand(venvPip, ["install", "cocotb~=2.0"]);

				if (installResult.success) {
					this.outputChannel.appendLine("✅ Cocotb installed successfully in current virtual environment!");
					this.outputChannel.appendLine(`Virtual environment location: ${process.env.VIRTUAL_ENV}`);

					// Update the configuration to use this Python
					const venvPython = path.join(process.env.VIRTUAL_ENV, "bin", "python");
					await cfg.update("cocotb.python.path", venvPython, vscode.ConfigurationTarget.Workspace);

					vscode.window.showInformationMessage("Cocotb installed successfully in current virtual environment!");
					return true;
				} else {
					this.outputChannel.appendLine(`❌ Failed to install in current virtual environment: ${installResult.error}`);
					this.outputChannel.appendLine("Creating new virtual environment for cocotb...");
				}
			} else {
				this.outputChannel.appendLine("No active virtual environment detected in extension process.");

				// Check for existing virtual environments in workspace
				const workspaceFolders = vscode.workspace.workspaceFolders;
				if (workspaceFolders) {
					const workspacePath = workspaceFolders[0].uri.fsPath;
					const existingVenvs = await this.findExistingVirtualEnvironments(workspacePath);

					if (existingVenvs.length > 0) {
						this.outputChannel.appendLine(`Found ${existingVenvs.length} existing virtual environment(s) in workspace:`);
						for (const venv of existingVenvs) {
							this.outputChannel.appendLine(`  - ${venv}`);
						}

						// Try to install in the first existing virtual environment
						const firstVenv = existingVenvs[0];
						this.outputChannel.appendLine(`Attempting to install cocotb in: ${firstVenv}`);

						const venvPip = path.join(firstVenv, "bin", "pip");
						const installResult = await this.runCommand(venvPip, ["install", "cocotb~=2.0"]);

						if (installResult.success) {
							this.outputChannel.appendLine("✅ Cocotb installed successfully in existing virtual environment!");
							this.outputChannel.appendLine(`Virtual environment location: ${firstVenv}`);

							// Update the configuration to use this Python
							const venvPython = path.join(firstVenv, "bin", "python");
							await cfg.update("cocotb.python.path", venvPython, vscode.ConfigurationTarget.Workspace);

							vscode.window.showInformationMessage("Cocotb installed successfully in existing virtual environment!");
							return true;
						} else {
							this.outputChannel.appendLine(`❌ Failed to install in existing virtual environment: ${installResult.error}`);
							this.outputChannel.appendLine("Creating new virtual environment for cocotb...");
						}
					} else {
						this.outputChannel.appendLine("No existing virtual environments found in workspace.");
						this.outputChannel.appendLine("Creating new virtual environment for cocotb...");
					}
				} else {
					this.outputChannel.appendLine("No workspace folder open.");
					this.outputChannel.appendLine("Creating new virtual environment for cocotb...");
				}
			}

			// Create new virtual environment in workspace
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders) {
				vscode.window.showErrorMessage("No workspace folder open. Please open a workspace first.");
				return false;
			}

			const workspacePath = workspaceFolders[0].uri.fsPath;
			const venvPath = path.join(workspacePath, ".cocotb-env");

			// Create virtual environment
			this.outputChannel.appendLine(`Creating virtual environment at: ${venvPath}`);
			const venvResult = await this.runCommand("python3", ["-m", "venv", venvPath]);

			if (!venvResult.success) {
				this.outputChannel.appendLine(`❌ Failed to create virtual environment: ${venvResult.error}`);
				vscode.window.showErrorMessage(`Failed to create virtual environment: ${venvResult.error}`);
				return false;
			}

			// Get the Python and pip paths in the virtual environment
			const venvPython = path.join(venvPath, "bin", "python");
			const venvPip = path.join(venvPath, "bin", "pip");

			// Install cocotb in the virtual environment
			this.outputChannel.appendLine("Installing cocotb in new virtual environment...");
			this.outputChannel.appendLine(`Command: ${venvPip} install 'cocotb~=2.0'`);
			this.outputChannel.appendLine("");

			const installResult = await this.runCommand(venvPip, ["install", "cocotb~=2.0"]);

			if (installResult.success) {
				this.outputChannel.appendLine("✅ Cocotb installed successfully in new virtual environment!");
				this.outputChannel.appendLine(`Virtual environment location: ${venvPath}`);
				this.outputChannel.appendLine(`Python path: ${venvPython}`);

				// Update the configuration to use this Python
				await cfg.update("cocotb.python.path", venvPython, vscode.ConfigurationTarget.Workspace);

				vscode.window.showInformationMessage("Cocotb installed successfully in new virtual environment!");
				return true;
			} else {
				this.outputChannel.appendLine(`❌ Failed to install cocotb: ${installResult.error}`);
				vscode.window.showErrorMessage(`Failed to install cocotb: ${installResult.error}`);
				return false;
			}
		} catch (error: any) {
			this.outputChannel.appendLine(`❌ Error installing cocotb: ${error.message}`);
			vscode.window.showErrorMessage(`Error installing cocotb: ${error.message}`);
			return false;
		}
	}

	public async installSimulator(): Promise<boolean> {
		const cfg = vscode.workspace.getConfiguration();
		const simulator = cfg.get<string>("cocotb.simulator.type", "iverilog");

		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine(`Setting up ${simulator}...`);

		try {
			if (simulator === "iverilog") {
				// First, try to find existing iverilog installation
				this.outputChannel.appendLine("🔍 Searching for existing iverilog installation...");
				const existingInstallation = await this.findExistingIverilogInstallation();

				if (existingInstallation) {
					this.outputChannel.appendLine(`✅ Found existing iverilog installation: ${existingInstallation}`);
					this.outputChannel.appendLine("Updating configuration to use existing installation...");

					// Update the configuration to use the found installation
					await cfg.update("cocotb.simulator.path", existingInstallation, vscode.ConfigurationTarget.Workspace);

					this.outputChannel.appendLine("✅ Configuration updated successfully!");
					vscode.window.showInformationMessage(`Found existing iverilog installation at: ${existingInstallation}`);
					return true;
				}

				// If no existing installation found, proceed with installation
				this.outputChannel.appendLine("❌ No existing iverilog installation found.");
				this.outputChannel.appendLine("Proceeding with installation...");
				this.outputChannel.appendLine("");

				return await this.installIverilogFromScratch();
			} else {
				vscode.window.showInformationMessage(`Please install ${simulator} manually. Check cocotb documentation for installation instructions.`);
				return false;
			}
		} catch (error: any) {
			this.outputChannel.appendLine(`❌ Error setting up ${simulator}: ${error.message}`);
			vscode.window.showErrorMessage(`Error setting up ${simulator}: ${error.message}`);
			return false;
		}
	}

	private async findExistingIverilogInstallation(): Promise<string | null> {
		try {
			// Try common iverilog command names
			const iverilogCommands = ["iverilog", "iverilog-gtk", "iverilog-vpi"];

			for (const cmd of iverilogCommands) {
				this.outputChannel.appendLine(`  Checking: ${cmd}`);

				const result = await this.runCommand("which", [cmd]);
				if (result.success && result.output.trim()) {
					const path = result.output.trim();
					this.outputChannel.appendLine(`    ✅ Found: ${path}`);

					// Verify it's actually iverilog by checking version
					const versionResult = await this.runCommand(cmd, ["-v"]);
					if (versionResult.success) {
						this.outputChannel.appendLine(`    ✅ Version check passed`);
						return path;
					} else {
						this.outputChannel.appendLine(`    ⚠️  Version check failed: ${versionResult.error}`);
					}
				} else {
					this.outputChannel.appendLine(`    ❌ Not found`);
				}
			}

			// Try to find in common installation directories
			this.outputChannel.appendLine("  Checking common installation directories...");
			const commonPaths = [
				"/usr/bin/iverilog",
				"/usr/local/bin/iverilog",
				"/opt/iverilog/bin/iverilog",
				"/usr/bin/iverilog-gtk",
				"/usr/local/bin/iverilog-gtk"
			];

			for (const path of commonPaths) {
				this.outputChannel.appendLine(`    Checking: ${path}`);

				const result = await this.runCommand("test", ["-x", path]);
				if (result.success) {
					this.outputChannel.appendLine(`    ✅ Found executable: ${path}`);

					// Verify it's actually iverilog
					const versionResult = await this.runCommand(path, ["-v"]);
					if (versionResult.success) {
						this.outputChannel.appendLine(`    ✅ Version check passed`);
						return path;
					} else {
						this.outputChannel.appendLine(`    ⚠️  Version check failed: ${versionResult.error}`);
					}
				} else {
					this.outputChannel.appendLine(`    ❌ Not found`);
				}
			}

			return null;
		} catch (error: any) {
			this.outputChannel.appendLine(`❌ Error searching for iverilog: ${error.message}`);
			return null;
		}
	}

	private async installIverilogFromScratch(): Promise<boolean> {
		try {
			let installCommand: string[];
			let installMessage: string;
			let requiresSudo = false;

			// Detect OS and provide appropriate command
			if (process.platform === "linux") {
				installCommand = ["sudo", "apt", "install", "iverilog"];
				installMessage = "Installing iverilog via apt...";
				requiresSudo = true;
			} else if (process.platform === "darwin") {
				installCommand = ["brew", "install", "icarus-verilog"];
				installMessage = "Installing iverilog via brew...";
			} else {
				vscode.window.showErrorMessage(`Please install iverilog manually for ${process.platform}. Visit: http://iverilog.icarus.com/`);
				return false;
			}

			// Show sudo warning if needed
			if (requiresSudo) {
				this.outputChannel.appendLine("⚠️  This installation requires sudo privileges.");
				this.outputChannel.appendLine("You will be prompted for your password in the terminal.");
				this.outputChannel.appendLine("");

				const proceed = await vscode.window.showWarningMessage(
					"Installing iverilog requires sudo privileges. You'll be prompted for your password.",
					"Proceed",
					"Cancel",
					"Show Manual Instructions"
				);

				if (proceed === "Cancel") {
					this.outputChannel.appendLine("Installation cancelled by user.");
					return false;
				} else if (proceed === "Show Manual Instructions") {
					this.showManualInstallInstructions();
					return false;
				}
			}

			this.outputChannel.appendLine(installMessage);
			this.outputChannel.appendLine(`Command: ${installCommand.join(" ")}`);
			this.outputChannel.appendLine("");

			if (requiresSudo) {
				this.outputChannel.appendLine("🔐 Running sudo command in integrated terminal...");
				this.outputChannel.appendLine("You will be prompted for your password in the terminal below.");
				this.outputChannel.appendLine("");

				// Use integrated terminal for sudo commands
				return await this.runSudoCommandInTerminal(installCommand);
			}

			const installResult = await this.runCommand(installCommand[0], installCommand.slice(1));

			if (installResult.success) {
				this.outputChannel.appendLine(`✅ iverilog installed successfully!`);
				vscode.window.showInformationMessage(`iverilog installed successfully!`);
				return true;
			} else {
				this.outputChannel.appendLine(`❌ Failed to install iverilog: ${installResult.error}`);

				// Check if it's a sudo-related error
				if (installResult.error.includes("sudo") || installResult.error.includes("password")) {
					this.outputChannel.appendLine("");
					this.outputChannel.appendLine("💡 This might be a sudo/password issue. Try manual installation:");
					this.showManualInstallInstructions();
				}

				vscode.window.showErrorMessage(`Failed to install iverilog: ${installResult.error}`);
				return false;
			}
		} catch (error: any) {
			this.outputChannel.appendLine(`❌ Error installing iverilog: ${error.message}`);
			vscode.window.showErrorMessage(`Error installing iverilog: ${error.message}`);
			return false;
		}
	}

	public async installGtkwave(): Promise<boolean> {
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine(`Setting up GTKWave...`);

		try {
			// First, try to find existing GTKWave installation
			const existingInstallation = await this.runCommand("gtkwave", ["--version"]);

			if (existingInstallation.success) {
				this.outputChannel.appendLine(`✅ Found existing GTKWave installation`);
				vscode.window.showInformationMessage(`GTKWave is already installed!`);
				return true;
			}

			// If no existing installation found, proceed with installation
			this.outputChannel.appendLine("❌ No existing installation found");
			this.outputChannel.appendLine("Proceeding with installation...");

			let installCommand: string[];
			let installMessage: string;
			let requiresSudo = false;

			// Detect OS and provide appropriate command
			if (process.platform === "linux") {
				installCommand = ["sudo", "apt", "install", "gtkwave"];
				installMessage = "Installing GTKWave via apt...";
				requiresSudo = true;
			} else if (process.platform === "darwin") {
				installCommand = ["brew", "install", "gtkwave"];
				installMessage = "Installing GTKWave via brew...";
			} else {
				vscode.window.showErrorMessage(`Please install GTKWave manually for ${process.platform}. Visit: http://gtkwave.sourceforge.net/`);
				return false;
			}

			// Show sudo warning if needed
			if (requiresSudo) {
				this.outputChannel.appendLine("⚠️  This installation requires sudo privileges.");
				this.outputChannel.appendLine("You will be prompted for your password in the terminal.");
				this.outputChannel.appendLine("");

				const proceed = await vscode.window.showWarningMessage(
					"GTKWave installation requires sudo privileges. Continue?",
					"Proceed",
					"Cancel",
					"Show Manual Instructions"
				);

				if (proceed === "Cancel") {
					this.outputChannel.appendLine("Installation cancelled by user.");
					return false;
				} else if (proceed === "Show Manual Instructions") {
					this.showGtkwaveManualInstallInstructions();
					return false;
				}
			}

			this.outputChannel.appendLine(installMessage);

			if (requiresSudo) {
				// Use terminal for sudo commands
				const sudoSuccess = await this.runSudoCommandInTerminal(installCommand);
				if (sudoSuccess) {
					this.outputChannel.appendLine(`✅ GTKWave installed successfully!`);
					vscode.window.showInformationMessage(`GTKWave installed successfully!`);
					return true;
				} else {
					this.outputChannel.appendLine(`❌ Failed to install GTKWave via sudo`);
					this.outputChannel.appendLine("");
					this.outputChannel.appendLine("💡 This might be a sudo/password issue. Try manual installation:");
					this.showGtkwaveManualInstallInstructions();
					vscode.window.showErrorMessage(`Failed to install GTKWave. Check the terminal for details.`);
					return false;
				}
			} else {
				// Direct execution for non-sudo commands
				const installResult = await this.runCommand(installCommand[0], installCommand.slice(1));
				if (installResult.success) {
					this.outputChannel.appendLine(`✅ GTKWave installed successfully!`);
					vscode.window.showInformationMessage(`GTKWave installed successfully!`);
					return true;
				} else {
					this.outputChannel.appendLine(`❌ Failed to install GTKWave: ${installResult.error}`);
					vscode.window.showErrorMessage(`Failed to install GTKWave: ${installResult.error}`);
					return false;
				}
			}
		} catch (error: any) {
			this.outputChannel.appendLine(`❌ Error installing GTKWave: ${error.message}`);
			vscode.window.showErrorMessage(`Error installing GTKWave: ${error.message}`);
			return false;
		}
	}

	public async viewWaveforms(): Promise<void> {
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine("🌊 Opening latest waveform in GTKWave...");

		try {
			// First check if GTKWave is available
			const gtkwaveCheck = await this.runCommand("gtkwave", ["--version"]);
			if (!gtkwaveCheck.success) {
				vscode.window.showErrorMessage("GTKWave is not installed. Please install it first using 'Check Prerequisites'.");
				this.outputChannel.appendLine("❌ GTKWave not found. Please install GTKWave first.");
				return;
			}


			// Get test directory
			const cfg = vscode.workspace.getConfiguration();
			const testDir = cfg.get<string>("cocotb.testDirectory", "");
			const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
			const targetDir = await this.getTestDirectory(testDir, activePath);
			if (!targetDir) return;

			this.outputChannel.appendLine(`Searching for waveform files in: ${targetDir}`);
			const waveformFiles = await this.findWaveformFiles(targetDir);
			let args: string[] = [];
			if (waveformFiles.length > 0) {
				const selected = waveformFiles[0];
				this.outputChannel.appendLine(`Using waveform: ${selected}`);
				args = [selected];
			} else {
				this.outputChannel.appendLine("No waveform files found. Opening GTKWave GUI only.");
			}

			this.outputChannel.appendLine(`Launching GTKWave: gtkwave ${args.join(" ")}`);
			const gtkwaveProcess = spawn("gtkwave", args, {
				cwd: targetDir,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true
			});

			// Don't wait for GTKWave to close, but log any immediate errors
			gtkwaveProcess.on("error", (error: Error) => {
				this.outputChannel.appendLine(`❌ Error launching GTKWave: ${error.message}`);
				vscode.window.showErrorMessage(`Failed to launch GTKWave: ${error.message}`);
			});

			// Log successful launch after a brief delay
			setTimeout(() => {
				if (gtkwaveProcess && !gtkwaveProcess.killed) {
					this.outputChannel.appendLine("✅ GTKWave launched successfully!");
					vscode.window.showInformationMessage("GTKWave opened.");
				}
			}, 1000);

			// Detach the process so it runs independently
			gtkwaveProcess.unref();

		} catch (error: any) {
			this.outputChannel.appendLine(`❌ Error opening waveforms: ${error.message}`);
			vscode.window.showErrorMessage(`Error opening waveforms: ${error.message}`);
		}
	}

	public async openGtkwaveGuiOnly(): Promise<void> {
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine("🪟 Opening GTKWave GUI (no file)...");
		try {
			const gtkwaveCheck = await this.runCommand("gtkwave", ["--version"]);
			if (!gtkwaveCheck.success) {
				vscode.window.showErrorMessage("GTKWave is not installed. Please install it first using 'Check Prerequisites'.");
				this.outputChannel.appendLine("❌ GTKWave not found. Please install GTKWave first.");
				return;
			}
			const workdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
			const p = spawn("gtkwave", [], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], detached: true });
			p.on("error", (error: Error) => {
				this.outputChannel.appendLine(`❌ Error launching GTKWave: ${error.message}`);
				vscode.window.showErrorMessage(`Failed to launch GTKWave: ${error.message}`);
			});
			setTimeout(() => {
				if (p && !p.killed) {
					this.outputChannel.appendLine("✅ GTKWave launched successfully!");
					vscode.window.showInformationMessage("GTKWave opened.");
				}
			}, 1000);
			p.unref();
		} catch (e: any) {
			this.outputChannel.appendLine(`❌ Error opening GTKWave: ${e?.message || e}`);
			vscode.window.showErrorMessage(`Error opening GTKWave: ${e?.message || e}`);
		}
	}

	public async setTestDirectory(): Promise<void> {
		const options: vscode.OpenDialogOptions = { canSelectMany: false, openLabel: "Select Test Directory", canSelectFolders: true, canSelectFiles: false };
		const folderUri = await vscode.window.showOpenDialog(options);
		if (folderUri && folderUri[0]) {
			const picked = folderUri[0];
			const cfg = vscode.workspace.getConfiguration();
			const hasWorkspace = Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
			await cfg.update(
				"cocotb.testDirectory",
				picked.fsPath,
				hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
			);
			vscode.window.showInformationMessage(
				`Cocotb test directory set to: ${picked.fsPath}${hasWorkspace ? "" : " (saved in User Settings)"}`
			);

			// Ensure the selected folder is visible in the Explorer
			try {
				const folders = vscode.workspace.workspaceFolders;
				if (!folders || folders.length === 0) {
					// No workspace open: offer to open the folder so it shows in Explorer
					const choice = await vscode.window.showInformationMessage(
						"Open selected test directory in this window so it appears in the Explorer?",
						"Open Folder",
						"Cancel"
					);
					if (choice === "Open Folder") {
						await vscode.commands.executeCommand('vscode.openFolder', picked, false);
					}
					return;
				}

				// We have a workspace open. Offer to either switch root or add to workspace
				const currentIsSingleFolder = folders.length === 1;
				const alreadyInWorkspace = folders.some(f => f.uri.fsPath === picked.fsPath);
				if (!alreadyInWorkspace) {
					let action: string | undefined;
					if (currentIsSingleFolder) {
						action = await vscode.window.showQuickPick([
							"Open This Folder (switch window)",
							"Add To Workspace"
						], { placeHolder: "How should the selected test directory appear in Explorer?" });
					} else {
						action = "Add To Workspace";
					}

					if (action === "Open This Folder (switch window)") {
						await vscode.commands.executeCommand('vscode.openFolder', picked, false);
						return;
					} else if (action === "Add To Workspace") {
						vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: picked });
					}
				}

			} catch { }

			// Notify sidebar of path update
			try {
				const { CocotbSidebar } = require('./cocotbSidebar');
				const sidebar = CocotbSidebar.getInstance();
				if (sidebar) {
					sidebar.postMessage({ command: 'pathUpdate', payload: { testDirectory: picked.fsPath } });
				}
			} catch { }
		}
	}

	private async findWaveformFiles(directory: string, maxDepth: number = 3): Promise<string[]> {
		const results: string[] = [];
		const visit = (dir: string, depth: number) => {
			if (depth < 0) return;
			let entries: fs.Dirent[] = [];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isFile() && (entry.name.endsWith('.fst') || entry.name.endsWith('.vcd'))) {
					results.push(full);
				} else if (entry.isDirectory()) {
					if ([".git", "node_modules", ".venv", "venv", ".cocotb-env", ".vscode"].includes(entry.name)) continue;
					visit(full, depth - 1);
				}
			}
		};
		visit(directory, maxDepth);
		// Sort: .fst first, then newest mtime
		results.sort((a, b) => {
			const aIsFst = a.endsWith('.fst');
			const bIsFst = b.endsWith('.fst');
			if (aIsFst !== bIsFst) return aIsFst ? -1 : 1;
			let am = 0, bm = 0;
			try { am = fs.statSync(a).mtime.getTime(); } catch { }
			try { bm = fs.statSync(b).mtime.getTime(); } catch { }
			return bm - am;
		});
		return results;
	}

	private showGtkwaveManualInstallInstructions(): void {
		this.outputChannel.appendLine("");
		this.outputChannel.appendLine("📋 GTKWave Manual Installation Instructions:");
		this.outputChannel.appendLine("");

		if (process.platform === "linux") {
			this.outputChannel.appendLine("1. Open a terminal");
			this.outputChannel.appendLine("2. Run: sudo apt update");
			this.outputChannel.appendLine("3. Run: sudo apt install gtkwave");
			this.outputChannel.appendLine("4. Verify: gtkwave --version");
		} else if (process.platform === "darwin") {
			this.outputChannel.appendLine("1. Install Homebrew if not already installed");
			this.outputChannel.appendLine("2. Run: brew install gtkwave");
			this.outputChannel.appendLine("3. Verify: gtkwave --version");
		} else {
			this.outputChannel.appendLine("1. Visit: http://gtkwave.sourceforge.net/");
			this.outputChannel.appendLine("2. Download and install for your platform");
			this.outputChannel.appendLine("3. Verify: gtkwave --version");
		}

		this.outputChannel.appendLine("");
		this.outputChannel.appendLine("After installation, run 'Cocotb: Check Prerequisites' to verify.");
		this.outputChannel.appendLine("");

		vscode.window.showInformationMessage(
			"GTKWave manual installation instructions shown in output channel. Run 'Cocotb: Check Prerequisites' after installation."
		);
	}

	private showManualInstallInstructions(): void {
		this.outputChannel.appendLine("");
		this.outputChannel.appendLine("📋 Manual Installation Instructions:");
		this.outputChannel.appendLine("");
		this.outputChannel.appendLine("1. Open a terminal");
		this.outputChannel.appendLine("2. Run: sudo apt update");
		this.outputChannel.appendLine("3. Run: sudo apt install iverilog");
		this.outputChannel.appendLine("4. Verify: iverilog -V");
		this.outputChannel.appendLine("");
		this.outputChannel.appendLine("After installation, run 'Cocotb: Check Prerequisites' to verify.");
		this.outputChannel.appendLine("");

		vscode.window.showInformationMessage(
			"Manual installation instructions shown in output channel. Run 'Cocotb: Check Prerequisites' after installation."
		);
	}

	private async runSudoCommandInTerminal(installCommand: string[]): Promise<boolean> {
		try {
			// Create or get the integrated terminal
			const terminal = vscode.window.createTerminal({
				name: "Cocotb Installation",
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
			});

			// Show the terminal
			terminal.show();

			// Send the command to the terminal
			const command = installCommand.join(" ");
			terminal.sendText(command);

			// Show success message
			this.outputChannel.appendLine(`✅ Command sent to terminal: ${command}`);
			this.outputChannel.appendLine("Please enter your password when prompted in the terminal.");
			this.outputChannel.appendLine("After installation completes, run 'Cocotb: Check Prerequisites' to verify.");

			vscode.window.showInformationMessage(
				"Installation command sent to terminal. Please enter your password when prompted. Run 'Cocotb: Check Prerequisites' after installation completes.",
				"Check Prerequisites"
			).then(selection => {
				if (selection === "Check Prerequisites") {
					// Wait a bit for installation to complete, then check
					setTimeout(() => {
						this.checkPrerequisites();
					}, 2000);
				}
			});

			return true; // We assume success since user will handle it manually
		} catch (error: any) {
			this.outputChannel.appendLine(`❌ Error running command in terminal: ${error.message}`);
			vscode.window.showErrorMessage(`Error running command in terminal: ${error.message}`);
			return false;
		}
	}

	public async debugSimulatorDetection(): Promise<void> {
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine("🔍 Debugging simulator detection...");
		this.outputChannel.appendLine("");

		// Check PATH
		this.outputChannel.appendLine("Environment PATH:");
		this.outputChannel.appendLine(process.env.PATH || "PATH not found");
		this.outputChannel.appendLine("");

		// Try different iverilog commands
		const commands = ["iverilog", "iverilog-gtk", "iverilog-vpi", "which iverilog", "whereis iverilog"];

		for (const cmd of commands) {
			this.outputChannel.appendLine(`Testing command: ${cmd}`);
			try {
				const result = await this.runCommand(cmd, cmd.includes("iverilog") ? ["-v"] : []);
				this.outputChannel.appendLine(`  Success: ${result.success}`);
				if (result.output) {
					this.outputChannel.appendLine(`  Output: ${result.output}`);
				}
				if (result.error) {
					this.outputChannel.appendLine(`  Error: ${result.error}`);
				}
			} catch (error: any) {
				this.outputChannel.appendLine(`  Exception: ${error.message}`);
			}
			this.outputChannel.appendLine("");
		}

		// Check configuration
		const cfg = vscode.workspace.getConfiguration();
		const simulatorType = cfg.get<string>("cocotb.simulator.type", "iverilog");
		const simulatorPath = cfg.get<string>("cocotb.simulator.path", "");

		this.outputChannel.appendLine("Configuration:");
		this.outputChannel.appendLine(`  Simulator type: ${simulatorType}`);
		this.outputChannel.appendLine(`  Simulator path: ${simulatorPath || "not set"}`);
	}

	public async getTestDirectoryPublic(configuredDir: string, activeFilePath?: string): Promise<string | undefined> {
		return this.getTestDirectory(configuredDir, activeFilePath);
	}

	private async getTestDirectory(configuredDir: string, activeFilePath?: string): Promise<string | undefined> {
		// Priority 1: User-configured directory
		if (configuredDir) {
			this.outputChannel.appendLine(`Using configured test directory: ${configuredDir}`);
			return configuredDir;
		}

		// Priority 2: Directory of currently active file
		if (activeFilePath) {
			const dir = path.dirname(activeFilePath);
			this.outputChannel.appendLine(`Using test directory from active file: ${dir}`);
			return dir;
		}

		// Priority 3: Auto-detect or ask user
		const foundDirs = await this.findAllCocotbTestDirectories();

		if (foundDirs.length === 0) {
			// No cocotb directories found - ask user what to do
			const action = await vscode.window.showInformationMessage(
				"No test directory specified. Choose how to proceed:",
				"Browse for Directory",
				"Configure Test Directory",
				"Use Current Workspace",
				"Cancel"
			);

			switch (action) {
				case "Browse for Directory":
					const selectedDir = await vscode.window.showOpenDialog({
						canSelectFiles: false,
						canSelectFolders: true,
						canSelectMany: false,
						openLabel: "Select Test Directory (where Makefile is/will be)"
					});
					if (selectedDir && selectedDir[0]) {
						const dir = selectedDir[0].fsPath;
						this.outputChannel.appendLine(`Selected test directory: ${dir}`);
						return dir;
					}
					return undefined;

				case "Configure Test Directory":
					vscode.commands.executeCommand('workbench.action.openSettings', 'cocotb.testDirectory');
					vscode.window.showInformationMessage("Please set 'cocotb.testDirectory' and try again.");
					return undefined;

				case "Use Current Workspace":
					const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (workspace) {
						this.outputChannel.appendLine(`Using workspace root as test directory: ${workspace}`);
						return workspace;
					}
					return undefined;

				default:
					return undefined;
			}
		} else if (foundDirs.length === 1) {
			// Single directory found
			const dir = foundDirs[0];
			this.outputChannel.appendLine(`Auto-detected test directory: ${dir}`);
			return dir;
		} else {
			// Multiple directories found - let user choose
			const items = foundDirs.map(dir => ({
				label: path.basename(dir),
				description: dir,
				detail: `Contains Makefile with cocotb configuration`
			}));

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: "Multiple test directories found. Select one:",
				ignoreFocusOut: true
			});

			if (selected) {
				const dir = selected.description;
				this.outputChannel.appendLine(`Selected test directory: ${dir}`);
				return dir;
			}
			return undefined;
		}
	}

	private async findAllCocotbTestDirectories(): Promise<string[]> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) return [];

		const cocotbDirs: string[] = [];

		for (const folder of workspaceFolders) {
			// Look for Makefile with cocotb content in root
			const makefilePath = path.join(folder.uri.fsPath, "Makefile");
			if (fs.existsSync(makefilePath)) {
				const content = fs.readFileSync(makefilePath, 'utf8');
				if (content.includes('cocotb') || content.includes('Makefile.sim')) {
					cocotbDirs.push(folder.uri.fsPath);
				}
			}

			// Look in subdirectories (recursive search, max 3 levels deep)
			this.searchCocotbDirectoriesRecursive(folder.uri.fsPath, cocotbDirs, 3);
		}

		return cocotbDirs;
	}

	private searchCocotbDirectoriesRecursive(dir: string, results: string[], maxDepth: number): void {
		if (maxDepth <= 0) return;

		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				if (entry.isDirectory()) {
					const subdirPath = path.join(dir, entry.name);

					// Skip common non-test directories
					if (['node_modules', '.git', '__pycache__', '.vscode', 'build', 'dist'].includes(entry.name)) {
						continue;
					}

					// Check for Makefile with cocotb content
					const makefilePath = path.join(subdirPath, "Makefile");
					if (fs.existsSync(makefilePath)) {
						const content = fs.readFileSync(makefilePath, 'utf8');
						if (content.includes('cocotb') || content.includes('Makefile.sim')) {
							results.push(subdirPath);
						}
					}

					// Recurse into subdirectory
					this.searchCocotbDirectoriesRecursive(subdirPath, results, maxDepth - 1);
				}
			}
		} catch (err) {
			// Ignore permission errors or other filesystem issues
		}
	}

	private async findCocotbTestDirectory(): Promise<string | undefined> {
		const dirs = await this.findAllCocotbTestDirectories();
		return dirs.length > 0 ? dirs[0] : undefined;
	}

	private async runCommand(command: string, args: string[]): Promise<{ success: boolean; output: string; error: string }> {
		return new Promise((resolve) => {
			const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
			let output = '';
			let error = '';

			if (process.stdout) {
				process.stdout.on('data', (data) => {
					output += data.toString();
				});
			}

			if (process.stderr) {
				process.stderr.on('data', (data) => {
					error += data.toString();
				});
			}

			process.on('close', (code) => {
				resolve({
					success: code === 0,
					output: output.trim(),
					error: error.trim()
				});
			});

			process.on('error', () => {
				resolve({
					success: false,
					output: '',
					error: `Failed to execute ${command}`
				});
			});
		});
	}

	public stopTests(): void {
		if (this.process) {
			this.process.kill("SIGTERM");
			this.outputChannel.appendLine("🛑 Cocotb tests stopped by user.");
			vscode.window.showInformationMessage("Cocotb tests stopped.");
			this.process = undefined;
		} else {
			vscode.window.showInformationMessage("No cocotb tests are currently running.");
		}
	}

	public isRunning(): boolean {
		return this.process !== undefined;
	}

	public dispose(): void {
		this.stopTests();
		this.outputChannel.dispose();
		while (this.disposables.length) {
			const d = this.disposables.pop();
			try { d?.dispose(); } catch { }
		}
		CocotbRunner.current = undefined;
	}
}

