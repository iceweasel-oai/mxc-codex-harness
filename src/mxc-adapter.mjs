import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const POLICY_VERSION = "0.7.0-alpha";

function normalizeOutput(value) {
  if (value == null) {
    return "";
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return String(value);
}

function normalizeExitCode(value) {
  if (typeof value === "number") {
    return value;
  }
  return 1;
}

function mergeUniquePaths(...pathLists) {
  const seen = new Set();
  const merged = [];
  for (const pathList of pathLists) {
    for (const entry of pathList || []) {
      const key = String(entry).toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

function pathAncestors(targetPath) {
  const out = [];
  let current = path.resolve(targetPath);
  let previous = null;
  while (current && current !== previous) {
    out.push(current);
    previous = current;
    current = path.dirname(current);
  }
  return out;
}

function quoteWindowsArg(arg) {
  if (arg.length === 0) {
    return '""';
  }
  if (!/[\s"]/u.test(arg)) {
    return arg;
  }
  let quoted = '"';
  let backslashRun = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashRun += 1;
      continue;
    }
    if (char === '"') {
      quoted += "\\".repeat(backslashRun * 2 + 1);
      quoted += '"';
      backslashRun = 0;
      continue;
    }
    if (backslashRun > 0) {
      quoted += "\\".repeat(backslashRun);
      backslashRun = 0;
    }
    quoted += char;
  }
  if (backslashRun > 0) {
    quoted += "\\".repeat(backslashRun * 2);
  }
  quoted += '"';
  return quoted;
}

function argvToWindowsCommandLine(argv) {
  return argv.map(quoteWindowsArg).join(" ");
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function pickFirstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      return path.resolve(candidate);
    } catch {
      // ignore malformed candidates
    }
  }
  return null;
}

function resolvePythonExecutable() {
  if (process.env.MXC_PYTHON) {
    return process.env.MXC_PYTHON;
  }

  const pyResult = spawnSync(
    "py",
    ["-3", "-c", "import sys; print(sys.executable)"],
    {
      encoding: "utf8",
      windowsHide: true,
    }
  );
  if (pyResult.status === 0) {
    const resolved = String(pyResult.stdout || "").trim();
    if (resolved) {
      return resolved;
    }
  }

  const whereResults = runCapture("where.exe", ["python"]);
  return pickFirstExistingPath(
    (whereResults || []).filter(
      (candidate) => !candidate.toLowerCase().includes("\\windowsapps\\")
    )
  );
}

function resolvePowerShellExecutable() {
  if (process.env.MXC_POWERSHELL) {
    return process.env.MXC_POWERSHELL;
  }

  const pwshResults = runCapture("where.exe", ["pwsh"]);
  const pwshPath = pickFirstExistingPath(pwshResults || []);
  if (pwshPath) {
    return pwshPath;
  }

  return path.join(
    process.env.WINDIR || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

function resolveCommandSpec(spec) {
  const command = [...spec.command];
  const readonlyExtras = [];
  const readwriteExtras = [];
  const env = { ...(spec.env || {}) };
  const executable = command[0]?.toLowerCase();

  if (executable === "python") {
    const pythonPath = resolvePythonExecutable();
    if (pythonPath) {
      command[0] = pythonPath;
      readonlyExtras.push(pythonPath);
      readonlyExtras.push(...pathAncestors(path.dirname(pythonPath)));
      const pythonHome = path.dirname(pythonPath);
      if (!env.PYTHONHOME) {
        env.PYTHONHOME = pythonHome;
      }
    }
  }

  if (executable === "powershell") {
    const powershellPath = resolvePowerShellExecutable();
    if (powershellPath) {
      command[0] = powershellPath;
      readonlyExtras.push(powershellPath);
      readonlyExtras.push(...pathAncestors(path.dirname(powershellPath)));
      const userProfile = process.env.USERPROFILE;
      if (userProfile) {
        readwriteExtras.push(
          path.join(
            userProfile,
            "AppData",
            "Roaming",
            "Microsoft",
            "Windows",
            "PowerShell",
            "PSReadLine"
          )
        );
      }
    }
  }

  return {
    ...spec,
    command,
    env,
    readOnlyPaths: mergeUniquePaths(spec.readOnlyPaths || [], readonlyExtras),
    writableRoots: mergeUniquePaths(spec.writableRoots || [], readwriteExtras),
  };
}

export function getHostRuntimeInfo() {
  return {
    python: resolvePythonExecutable(),
    powershell: resolvePowerShellExecutable(),
    pwsh: pickFirstExistingPath(runCapture("where.exe", ["pwsh"]) || []),
  };
}

function sdkSurfaceSummary(sdk) {
  const summary = {};
  for (const [key, value] of Object.entries(sdk)) {
    if (typeof value === "function") {
      summary[key] = "function";
      continue;
    }
    if (value && typeof value === "object") {
      summary[key] = Object.keys(value)
        .filter((childKey) => typeof value[childKey] === "function")
        .sort();
      continue;
    }
    summary[key] = typeof value;
  }
  return summary;
}

async function loadSdkModule() {
  if (process.env.MXC_ADAPTER_MODULE) {
    const customModulePath = pathToFileURL(
      path.resolve(process.cwd(), process.env.MXC_ADAPTER_MODULE)
    ).href;
    return import(customModulePath);
  }
  return import("@microsoft/mxc-sdk");
}

function buildPolicy(spec, sdk) {
  const toolsPolicy = sdk.getAvailableToolsPolicy?.(process.env, {
    containerType: "appcontainer",
  }) || { readonlyPaths: [], readwritePaths: [] };
  const userPolicy = sdk.getUserProfilePolicy?.() || {
    readonlyPaths: [],
    readwritePaths: [],
  };
  const tempPolicy = sdk.getTemporaryFilesPolicy?.(process.env) || {
    readonlyPaths: [],
    readwritePaths: [],
  };

  return {
    version: POLICY_VERSION,
    filesystem: {
      readwritePaths: mergeUniquePaths(
        spec.writableRoots || [],
        toolsPolicy.readwritePaths,
        userPolicy.readwritePaths,
        tempPolicy.readwritePaths
      ),
      readonlyPaths: mergeUniquePaths(
        spec.readOnlyPaths || [],
        toolsPolicy.readonlyPaths,
        userPolicy.readonlyPaths,
        tempPolicy.readonlyPaths
      ),
      deniedPaths: mergeUniquePaths(spec.deniedPaths || []),
      clearPolicyOnExit: true,
    },
    ui: {
      allowWindows: spec.allowWindows === true,
    },
    network:
      spec.networkAccess === "enabled"
        ? { allowOutbound: true, allowLocalNetwork: true }
        : { allowOutbound: false, allowLocalNetwork: false },
    timeoutMs: spec.timeoutMs || 0,
  };
}

function buildOptions(spec) {
  const options = {
    usePty: false,
  };
  if (process.env.MXC_EXECUTABLE_PATH) {
    options.executablePath = process.env.MXC_EXECUTABLE_PATH;
  }
  if (process.env.MXC_LOG_DIR) {
    options.logDir = process.env.MXC_LOG_DIR;
  }
  if (process.env.MXC_DEBUG === "1") {
    options.debug = true;
  }
  if (process.env.MXC_EXPERIMENTAL === "1") {
    options.experimental = true;
  }
  if (spec.dryRun) {
    options.dryRun = true;
  }
  return options;
}

function buildSandboxEnv(specEnv) {
  if (specEnv === process.env) {
    return { ...process.env };
  }

  const passthroughKeys = [
    "SystemDrive",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATH",
    "Path",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramData",
    "PSModulePath",
  ];

  const merged = {};
  for (const key of passthroughKeys) {
    if (process.env[key]) {
      merged[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(specEnv || {})) {
    if (value != null) {
      merged[key] = value;
    }
  }
  return merged;
}

async function runViaSpawnSandboxFromConfig(sdk, spec) {
  if (typeof sdk.buildSandboxPayload !== "function") {
    return null;
  }
  if (typeof sdk.spawnSandboxFromConfig !== "function") {
    return null;
  }

  const resolvedSpec = resolveCommandSpec(spec);
  const script = argvToWindowsCommandLine(resolvedSpec.command);
  const policy = buildPolicy(resolvedSpec, sdk);
  const config = sdk.buildSandboxPayload(script, policy, resolvedSpec.cwd);
  const sandboxEnv = buildSandboxEnv(resolvedSpec.env);
  if (Object.keys(sandboxEnv).length > 0) {
    config.process = config.process || {};
    config.process.env = Object.entries(sandboxEnv).map(
      ([key, value]) => `${key}=${value}`
    );
  }
  const child = sdk.spawnSandboxFromConfig(
    config,
    buildOptions(resolvedSpec),
    resolvedSpec.cwd,
    sandboxEnv
  );

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += normalizeOutput(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += normalizeOutput(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: normalizeExitCode(exitCode),
        stdout,
        stderr,
        resolvedCommand: resolvedSpec.command,
        commandLine: script,
      });
    });
  });
}

function dumpSdkSurfaceText(sdk) {
  const summary = sdkSurfaceSummary(sdk);
  return [
    "Discovered SDK exports:",
    ...Object.keys(summary)
      .sort()
      .map((key) => `${key}: ${JSON.stringify(summary[key])}`),
  ].join("\n");
}

export async function dumpSdkSurface() {
  const sdk = await loadSdkModule();
  return {
    exports: Object.keys(sdk).sort(),
    surface: sdkSurfaceSummary(sdk),
  };
}

export async function runMxcCommand(spec) {
  const sdk = await loadSdkModule();

  if (typeof sdk.runMxcCommand === "function") {
    return sdk.runMxcCommand(spec);
  }

  const result = await runViaSpawnSandboxFromConfig(sdk, spec);
  if (result != null) {
    return result;
  }

  throw new Error(
    `Unable to find a usable MXC entrypoint automatically.\n${dumpSdkSurfaceText(sdk)}\nUpdate src/mxc-adapter.mjs to map the normalized spec to the real SDK API.`
  );
}
