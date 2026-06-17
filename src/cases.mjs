import fs from "node:fs/promises";
import path from "node:path";
import { getHostRuntimeInfo } from "./mxc-adapter.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const PYTHON_BIN = process.env.MXC_PYTHON || "python";
const HOST_RUNTIMES = getHostRuntimeInfo();

function windowsPath(value) {
  return value.replaceAll("/", "\\");
}

function randomLabel(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function writeFile(filePath, contents) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, contents, "utf8");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function commandFailed(result) {
  return (result.exitCode ?? 1) !== 0 || result.timedOut === true;
}

function commandSucceeded(result) {
  return (result.exitCode ?? 1) === 0 && result.timedOut !== true;
}

function assertResult(ok, detail) {
  return { ok, detail };
}

function isStartupFailure(result) {
  return result.exitCode === 3221225794 || result.exitCode === 3221225506;
}

function assertBlocked(result, detail) {
  if (isStartupFailure(result)) {
    return assertResult(false, `unsupported: startup failed (${detail})`);
  }
  return assertResult(commandFailed(result), detail);
}

function workspaceWriteSpec(ctx, command, overrides = {}) {
  return {
    command,
    cwd: ctx.workspace,
    env: {},
    writableRoots: [ctx.workspace],
    readOnlyPaths: [],
    networkAccess: "disabled",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...overrides,
  };
}

function workspaceWithDeniedGitSpec(ctx, command, overrides = {}) {
  return workspaceWriteSpec(ctx, command, {
    deniedPaths: [path.join(ctx.workspace, ".git")],
    ...overrides,
  });
}

function powershellSpec(ctx, command, overrides = {}) {
  return workspaceWriteSpec(ctx, [
    "powershell",
    "-NoLogo",
    "-NoProfile",
    "-Command",
    command,
  ], {
    allowWindows: true,
    ...overrides,
  });
}

async function makeCaseContext(rootDir, caseId) {
  const caseRoot = path.join(rootDir, caseId);
  const workspace = path.join(caseRoot, "workspace");
  const outside = path.join(caseRoot, "outside");
  const extra = path.join(caseRoot, "extra");
  await ensureDir(workspace);
  await ensureDir(outside);
  await ensureDir(extra);
  return {
    id: caseId,
    caseRoot,
    workspace,
    outside,
    extra,
    randomLabel,
  };
}

const smokeCases = [
  {
    id: "ws_cmd_write_allowed",
    name: "SMOKE: cmd write in CWD allowed",
    async run(ctx) {
      const target = path.join(ctx.workspace, "ws_ok.txt");
      await removePath(target);
      return {
        spec: workspaceWriteSpec(ctx, ["cmd", "/c", "echo ok > ws_ok.txt"]),
        async assert(result) {
          return assertResult(
            commandSucceeded(result) && (await pathExists(target)),
            `${commandDebugDetail(result)}, file=${await pathExists(target)}`
          );
        },
      };
    },
  },
  {
    id: "ws_powershell_write_allowed",
    name: "SMOKE: PowerShell Set-Content allowed",
    async run(ctx) {
      const target = path.join(ctx.workspace, "ps_ok.txt");
      const scriptPath = path.join(ctx.workspace, "write_file.ps1");
      await removePath(target);
      await removePath(scriptPath);
      await writeFile(
        scriptPath,
        "try { Set-Content -LiteralPath ps_ok.txt -Value 'hello' -Encoding ASCII -ErrorAction Stop; 'write-ok'; exit 0 } catch { $_ | Out-String | Write-Output; exit 1 }\n"
      );
      return {
        spec: workspaceWriteSpec(ctx, [
          "powershell",
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          "write_file.ps1",
        ], {
          allowWindows: true,
        }),
        async assert(result) {
          return assertResult(
            commandSucceeded(result) && (await pathExists(target)),
            `${commandDebugDetail(result)}, file=${await pathExists(target)}`
          );
        },
      };
    },
  },
  {
    id: "ws_python_write_allowed",
    name: "SMOKE: Python file write allowed",
    async run(ctx) {
      const target = path.join(ctx.workspace, "py_ok.txt");
      const scriptPath = path.join(ctx.workspace, "write_file.py");
      await removePath(target);
      await removePath(scriptPath);
      await writeFile(
        scriptPath,
        "from pathlib import Path\nPath('py_ok.txt').write_text('x', encoding='utf-8')\n"
      );
      return {
        spec: workspaceWriteSpec(ctx, [PYTHON_BIN, "write_file.py"]),
        async assert(result) {
          return assertResult(
            commandSucceeded(result) && (await pathExists(target)),
            `${commandDebugDetail(result)}, file=${await pathExists(target)}`
          );
        },
      };
    },
  },
  {
    id: "ws_write_outside_denied",
    name: "SMOKE: write outside workspace denied",
    async run(ctx) {
      const target = path.join(ctx.outside, "blocked.txt");
      await removePath(target);
      const targetWindows = windowsPath(target);
      return {
        spec: workspaceWriteSpec(ctx, [
          "cmd",
          "/c",
          `echo nope > "${targetWindows}"`,
        ]),
        async assert(result) {
          return assertResult(
            commandFailed(result) && !(await pathExists(target)),
            `${commandDebugDetail(result)}, file=${await pathExists(target)}`
          );
        },
      };
    },
  },
  {
    id: "ws_read_omitted_path_denied",
    name: "SMOKE: read omitted path denied",
    async run(ctx) {
      const target = path.join(ctx.outside, "secret.txt");
      await writeFile(target, "secret\n");
      const targetWindows = windowsPath(target);
      return {
        spec: workspaceWriteSpec(ctx, ["cmd", "/c", `type "${targetWindows}"`]),
        async assert(result) {
          return assertResult(
            commandFailed(result) && !result.stdout.includes("secret"),
            `${commandDebugDetail(result)}, leaked=${result.stdout.includes("secret")}`
          );
        },
      };
    },
  },
];

const diagnosticCases = [
  {
    id: "diag_python_version",
    name: "DIAG: Python --version",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, [PYTHON_BIN, "--version"]),
        async assert(result) {
          return assertResult(
            commandSucceeded(result),
            `${commandDebugDetail(result)}, python=${HOST_RUNTIMES.python || "not found"}`
          );
        },
      };
    },
  },
  {
    id: "diag_python_version_broad_runtime",
    name: "DIAG: Python --version with broad runtime read",
    async run(ctx) {
      const systemDriveRoot = `${process.env.SystemDrive || "C:"}\\`;
      return {
        spec: workspaceWriteSpec(ctx, [PYTHON_BIN, "--version"], {
          readOnlyPaths: [systemDriveRoot],
        }),
        async assert(result) {
          return assertResult(
            commandSucceeded(result),
            `${commandDebugDetail(result)}, readonly=${systemDriveRoot}`
          );
        },
      };
    },
  },
  {
    id: "diag_python_version_full_env",
    name: "DIAG: Python --version with full env",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, [PYTHON_BIN, "--version"], {
          env: process.env,
        }),
        async assert(result) {
          return assertResult(
            commandSucceeded(result),
            `${commandDebugDetail(result)}, env=full`
          );
        },
      };
    },
  },
  {
    id: "diag_powershell_version",
    name: "DIAG: Windows PowerShell version",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, [
          "powershell",
          "-NoLogo",
          "-NoProfile",
          "-Command",
          "$PSVersionTable.PSVersion.ToString()",
        ], {
          allowWindows: true,
        }),
        async assert(result) {
          return assertResult(
            commandSucceeded(result),
            `${commandDebugDetail(result)}, powershell=${HOST_RUNTIMES.powershell || "not found"}`
          );
        },
      };
    },
  },
  {
    id: "diag_powershell_version_full_env",
    name: "DIAG: Windows PowerShell version with full env",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, [
          "powershell",
          "-NoLogo",
          "-NoProfile",
          "-Command",
          "$PSVersionTable.PSVersion.ToString()",
        ], {
          allowWindows: true,
          env: process.env,
        }),
        async assert(result) {
          return assertResult(
            commandSucceeded(result),
            `${commandDebugDetail(result)}, env=full`
          );
        },
      };
    },
  },
  ...(HOST_RUNTIMES.pwsh
    ? [
        {
          id: "diag_pwsh_version",
          name: "DIAG: pwsh --version",
          async run(ctx) {
            return {
              spec: workspaceWriteSpec(ctx, [HOST_RUNTIMES.pwsh, "--version"], {
                allowWindows: true,
              }),
              async assert(result) {
                return assertResult(
                  commandSucceeded(result),
                  `${commandDebugDetail(result)}, pwsh=${HOST_RUNTIMES.pwsh}`
                );
              },
            };
          },
        },
      ]
    : []),
];

const networkCases = [
  {
    id: "net_iwr_https_blocked",
    name: "NET: Invoke-WebRequest HTTPS blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "try { Invoke-WebRequest https://example.com -TimeoutSec 4 | Out-Null; exit 0 } catch { exit 1 }",
          {
          timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stderr=${trimDetail(result.stderr)}`
          );
        },
      };
    },
  },
  {
    id: "net_tcp_53_blocked",
    name: "NET: direct TCP connect to 8.8.8.8:53 blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "$client = New-Object System.Net.Sockets.TcpClient; try { $iar = $client.BeginConnect('8.8.8.8', 53, $null, $null); if (-not $iar.AsyncWaitHandle.WaitOne(3000)) { $client.Close(); exit 1 }; $client.EndConnect($iar); $client.Close(); exit 0 } catch { try { $client.Close() } catch {}; exit 1 }",
          {
          timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_udp_53_blocked",
    name: "NET: direct UDP DNS send to 8.8.8.8:53 blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "$udp = New-Object System.Net.Sockets.UdpClient; try { $udp.Client.ReceiveTimeout = 3000; $query = [byte[]](0x12,0x34,0x01,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x06,0x67,0x6f,0x6f,0x67,0x6c,0x65,0x03,0x63,0x6f,0x6d,0x00,0x00,0x01,0x00,0x01); [void]$udp.Send($query, $query.Length, '8.8.8.8', 53); $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0); [void]$udp.Receive([ref]$remote); $udp.Close(); exit 0 } catch { try { $udp.Close() } catch {}; exit 1 }",
          {
            timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_nslookup_blocked",
    name: "NET: nslookup explicit resolver blocked",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, [
          "nslookup",
          "google.com",
          "8.8.8.8",
        ], {
          timeoutMs: 10_000,
        }),
        async assert(result) {
          return assertResult(
            commandFailed(result),
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_dotnet_dns_blocked",
    name: "NET: .NET DNS lookup blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "try { [System.Net.Dns]::GetHostAddresses('google.com') | Out-Null; exit 0 } catch { exit 1 }",
          {
            timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stderr=${trimDetail(result.stderr)}`
          );
        },
      };
    },
  },
  {
    id: "net_dnsqueryw_blocked",
    name: "NET: DnsQuery_W blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "$sig = '[DllImport(\"dnsapi.dll\", CharSet=CharSet.Unicode)] public static extern int DnsQuery_W(string pszName, short wType, int options, IntPtr extra, out IntPtr results, IntPtr reserved); [DllImport(\"dnsapi.dll\")] public static extern void DnsRecordListFree(IntPtr recordList, int freeType);'; Add-Type -Name NativeDns -Namespace MxcHarness -MemberDefinition $sig; $records = [IntPtr]::Zero; $status = [MxcHarness.NativeDns]::DnsQuery_W('google.com', 1, 0, [IntPtr]::Zero, [ref]$records, [IntPtr]::Zero); if ($records -ne [IntPtr]::Zero) { [MxcHarness.NativeDns]::DnsRecordListFree($records, 1) }; if ($status -eq 0) { exit 0 }; exit 1",
          {
            timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}, stderr=${trimDetail(result.stderr)}`
          );
        },
      };
    },
  },
  {
    id: "net_getaddrinfo_blocked",
    name: "NET: GetAddrInfoW blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "$sig = '[StructLayout(LayoutKind.Sequential)] public struct ADDRINFOW { public int ai_flags; public int ai_family; public int ai_socktype; public int ai_protocol; public UIntPtr ai_addrlen; public string ai_canonname; public IntPtr ai_addr; public IntPtr ai_next; } [DllImport(\"ws2_32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetAddrInfoW(string nodeName, string serviceName, IntPtr hints, out IntPtr result); [DllImport(\"ws2_32.dll\")] public static extern void FreeAddrInfoW(IntPtr result);'; Add-Type -Name NativeWs2 -Namespace MxcHarness -MemberDefinition $sig; $result = [IntPtr]::Zero; $status = [MxcHarness.NativeWs2]::GetAddrInfoW('google.com', $null, [IntPtr]::Zero, [ref]$result); if ($result -ne [IntPtr]::Zero) { [MxcHarness.NativeWs2]::FreeAddrInfoW($result) }; if ($status -eq 0) { exit 0 }; exit 1",
          {
            timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}, stderr=${trimDetail(result.stderr)}`
          );
        },
      };
    },
  },
  {
    id: "net_ping_blocked",
    name: "NET: ping.exe blocked",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, [
          "ping",
          "-n",
          "1",
          "-w",
          "3000",
          "1.1.1.1",
        ], {
          timeoutMs: 10_000,
        }),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_dotnet_ping_blocked",
    name: "NET: .NET Ping blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "try { $ping = New-Object System.Net.NetworkInformation.Ping; $reply = $ping.Send('1.1.1.1', 3000); if ($reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) { exit 0 }; exit 1 } catch { exit 1 }",
          {
            timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_icmpsendecho_blocked",
    name: "NET: IcmpSendEcho blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "$sig = '[DllImport(\"iphlpapi.dll\", SetLastError=true)] public static extern IntPtr IcmpCreateFile(); [DllImport(\"iphlpapi.dll\", SetLastError=true)] public static extern bool IcmpCloseHandle(IntPtr handle); [DllImport(\"iphlpapi.dll\", SetLastError=true)] public static extern uint IcmpSendEcho(IntPtr icmpHandle, uint destinationAddress, byte[] requestData, ushort requestSize, IntPtr requestOptions, byte[] replyBuffer, uint replySize, uint timeout);'; Add-Type -Name NativeIcmp -Namespace MxcHarness -MemberDefinition $sig; $handle = [MxcHarness.NativeIcmp]::IcmpCreateFile(); if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr](-1)) { exit 1 }; try { $payload = [Text.Encoding]::ASCII.GetBytes('mxc'); $reply = New-Object byte[] 256; $dest = [BitConverter]::ToUInt32([byte[]](1,1,1,1), 0); $count = [MxcHarness.NativeIcmp]::IcmpSendEcho($handle, $dest, $payload, [uint16]$payload.Length, [IntPtr]::Zero, $reply, [uint32]$reply.Length, 3000); if ($count -gt 0) { exit 0 }; exit 1 } finally { [void][MxcHarness.NativeIcmp]::IcmpCloseHandle($handle) }",
          {
            timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}, stderr=${trimDetail(result.stderr)}`
          );
        },
      };
    },
  },
  {
    id: "net_tcp_445_blocked",
    name: "NET: direct TCP connect to 1.1.1.1:445 blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "$client = New-Object System.Net.Sockets.TcpClient; try { $iar = $client.BeginConnect('1.1.1.1', 445, $null, $null); if (-not $iar.AsyncWaitHandle.WaitOne(3000)) { $client.Close(); exit 1 }; $client.EndConnect($iar); $client.Close(); exit 0 } catch { try { $client.Close() } catch {}; exit 1 }",
          {
            timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_tcp_445_hostname_blocked",
    name: "NET: hostname TCP connect to example.com:445 blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "$client = New-Object System.Net.Sockets.TcpClient; try { $iar = $client.BeginConnect('example.com', 445, $null, $null); if (-not $iar.AsyncWaitHandle.WaitOne(3000)) { $client.Close(); exit 1 }; $client.EndConnect($iar); $client.Close(); exit 0 } catch { try { $client.Close() } catch {}; exit 1 }",
          {
            timeoutMs: 10_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_unc_ip_blocked",
    name: "NET: UNC dir to IP blocked",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, ["cmd", "/c", "dir \\\\1.1.1.1\\share"], {
          timeoutMs: 10_000,
        }),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_unc_hostname_blocked",
    name: "NET: UNC dir to hostname blocked",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, ["cmd", "/c", "dir \\\\example.com\\share"], {
          timeoutMs: 10_000,
        }),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_net_view_blocked",
    name: "NET: net view UNC blocked",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, ["net", "view", "\\\\1.1.1.1"], {
          timeoutMs: 10_000,
        }),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_net_use_blocked",
    name: "NET: net use IPC$ blocked",
    async run(ctx) {
      return {
        spec: workspaceWriteSpec(ctx, ["net", "use", "\\\\1.1.1.1\\IPC$"], {
          timeoutMs: 10_000,
        }),
        async assert(result) {
          return assertResult(
            commandFailed(result),
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}`
          );
        },
      };
    },
  },
  {
    id: "net_logon_netcredentials_only_blocked",
    name: "NET: LOGON_NETCREDENTIALS_ONLY UNC blocked",
    async run(ctx) {
      return {
        spec: powershellSpec(
          ctx,
          "$sig = '[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; } [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; } [DllImport(\"advapi32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessWithLogonW(string username, string domain, string password, int logonFlags, string applicationName, string commandLine, int creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInfo); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);'; Add-Type -Name NativeLogon -Namespace MxcHarness -MemberDefinition $sig; $si = New-Object MxcHarness.NativeLogon+STARTUPINFO; $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si); $pi = New-Object MxcHarness.NativeLogon+PROCESS_INFORMATION; $cmd = 'cmd.exe /c dir \\\\1.1.1.1\\share'; $ok = [MxcHarness.NativeLogon]::CreateProcessWithLogonW('mxcuser', '.', 'mxcpass', 2, $null, $cmd, 0, [IntPtr]::Zero, (Get-Location).Path, [ref]$si, [ref]$pi); if (-not $ok) { exit 1 }; try { [void][MxcHarness.NativeLogon]::WaitForSingleObject($pi.hProcess, 10000); $childExit = 1; [void][MxcHarness.NativeLogon]::GetExitCodeProcess($pi.hProcess, [ref]$childExit); if ($childExit -eq 0) { exit 0 }; exit 1 } finally { [void][MxcHarness.NativeLogon]::CloseHandle($pi.hThread); [void][MxcHarness.NativeLogon]::CloseHandle($pi.hProcess) }",
          {
            timeoutMs: 15_000,
          }
        ),
        async assert(result) {
          return assertBlocked(
            result,
            `exit=${result.exitCode}, stdout=${trimDetail(result.stdout)}, stderr=${trimDetail(result.stderr)}`
          );
        },
      };
    },
  },
];

const gitCases = [
  {
    id: "git_missing_dir_create_denied",
    name: "GIT: missing .git directory cannot be created",
    async run(ctx) {
      const gitDir = path.join(ctx.workspace, ".git");
      await removePath(gitDir);
      return {
        spec: workspaceWithDeniedGitSpec(ctx, ["cmd", "/c", "mkdir .git"]),
        async assert(result) {
          return assertResult(
            commandFailed(result) && !(await pathExists(gitDir)),
            `exit=${result.exitCode}, exists=${await pathExists(gitDir)}`
          );
        },
      };
    },
  },
  {
    id: "git_missing_config_write_denied",
    name: "GIT: missing .git\\config write denied",
    async run(ctx) {
      const gitDir = path.join(ctx.workspace, ".git");
      const configPath = path.join(gitDir, "config");
      await removePath(gitDir);
      return {
        spec: workspaceWithDeniedGitSpec(ctx, [
          "cmd",
          "/c",
          "echo hack > .git\\config",
        ]),
        async assert(result) {
          return assertResult(
            commandFailed(result) &&
              !(await pathExists(gitDir)) &&
              !(await pathExists(configPath)),
            `exit=${result.exitCode}, git=${await pathExists(gitDir)}, config=${await pathExists(configPath)}`
          );
        },
      };
    },
  },
  {
    id: "git_case_variation_denied",
    name: "GIT: .GiT case-variation write denied",
    async run(ctx) {
      const gitDir = path.join(ctx.workspace, ".GiT");
      const configPath = path.join(gitDir, "config");
      await removePath(gitDir);
      return {
        spec: workspaceWithDeniedGitSpec(ctx, [
          "cmd",
          "/c",
          "echo hack > .GiT\\config",
        ]),
        async assert(result) {
          return assertResult(
            commandFailed(result) &&
              !(await pathExists(gitDir)) &&
              !(await pathExists(configPath)),
            `exit=${result.exitCode}, git=${await pathExists(gitDir)}, config=${await pathExists(configPath)}`
          );
        },
      };
    },
  },
  {
    id: "git_existing_config_write_denied",
    name: "GIT: existing .git\\config remains read-only",
    async run(ctx) {
      const gitDir = path.join(ctx.workspace, ".git");
      const configPath = path.join(gitDir, "config");
      await ensureDir(gitDir);
      await writeFile(configPath, "[core]\nrepositoryformatversion = 0\n");
      return {
        spec: workspaceWithDeniedGitSpec(ctx, [
          "cmd",
          "/c",
          "echo hacked > .git\\config",
        ]),
        async assert(result) {
          const contents = await fs.readFile(configPath, "utf8");
          return assertResult(
            commandFailed(result) && !contents.includes("hacked"),
            `exit=${result.exitCode}, preserved=${!contents.includes("hacked")}`
          );
        },
      };
    },
  },
];

export const suites = {
  smoke: smokeCases,
  diagnostic: diagnosticCases,
  network: networkCases,
  git: gitCases,
};

export function listSuiteNames() {
  return Object.keys(suites);
}

export function listCasesForSuite(suiteName) {
  if (suiteName === "all") {
    return Object.values(suites).flat();
  }
  return suites[suiteName] || [];
}

export async function createCasePlan(rootDir, suiteName) {
  const cases = listCasesForSuite(suiteName);
  return Promise.all(
    cases.map(async (testCase) => ({
      testCase,
      ctx: await makeCaseContext(rootDir, testCase.id),
    }))
  );
}

function trimDetail(value) {
  if (!value) {
    return "";
  }
  const trimmed = String(value).replace(/\s+/g, " ").trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 117)}...`;
}

function commandDebugDetail(result) {
  const parts = [];
  if (result.exitCode != null) {
    parts.push(`exit=${result.exitCode}`);
  }
  if (result.commandLine) {
    parts.push(`cmd=${trimDetail(result.commandLine)}`);
  }
  if (result.stdout) {
    parts.push(`stdout=${trimDetail(result.stdout)}`);
  }
  if (result.stderr) {
    parts.push(`stderr=${trimDetail(result.stderr)}`);
  }
  return parts.join(", ");
}
