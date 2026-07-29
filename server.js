const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const DLL_PATH = path.join(__dirname, 'Libre', 'LibreHardwareMonitorLib.dll').replace(/\\/g, '\\\\');

// ---------------------------------------------------------------------------
// PowerShell — collects every sensor for CPU + GPU, tries DLL then WMI
// Returns structured JSON with temps, loads, clocks, fans, power, and limits
// ---------------------------------------------------------------------------
const PS_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
$method = "none"

# Output containers
$cpu = [ordered]@{
  name    = "CPU"
  package = $null; packageMax = $null
  cores   = [System.Collections.ArrayList]@()
  load    = $null; loads = [System.Collections.ArrayList]@()
  clocks  = [System.Collections.ArrayList]@()
  power   = [System.Collections.ArrayList]@()
  fans    = [System.Collections.ArrayList]@()
}
$gpu = [ordered]@{
  name    = "GPU"
  sensors = [System.Collections.ArrayList]@()   # all GPU sensors flat
}

# ── DLL method ───────────────────────────────────────────────────────────────
try {
  Add-Type -Path "${DLL_PATH}" -ErrorAction Stop
  $comp = New-Object LibreHardwareMonitor.Hardware.Computer
  $comp.IsCpuEnabled = $true
  $comp.IsGpuEnabled = $true
  $comp.Open()

  $ST = [LibreHardwareMonitor.Hardware.SensorType]

  foreach ($hw in $comp.Hardware) {
    $hw.Update()
    $allHw = @($hw) + @($hw.SubHardware)
    foreach ($h in $allHw) {
      if ($h -ne $hw) { $h.Update() }

      foreach ($s in $h.Sensors) {
        if ($s.Value -eq $null) { continue }
        $v    = [math]::Round([double]$s.Value, 1)
        $vmax = if ($s.Max -ne $null) { [math]::Round([double]$s.Max, 1) } else { $null }
        $name = $s.Name
        $type = $s.SensorType.ToString()
        $hwt  = $h.HardwareType.ToString()

        # ── CPU ──
        if ($hwt -match "Cpu") {
          $cpu.name = $hw.Name

          if ($type -eq "Temperature") {
            if ($name -match "Package|Tdie|Tctl|CCD" -and $cpu.package -eq $null) {
              $cpu.package    = $v
              $cpu.packageMax = $vmax
            } elseif ($name -match "Core" -and $name -match "(\\d+)\\s*$") {
              $n = [int]$Matches[1]
              if (-not ($cpu.cores | Where-Object { $_.core -eq $n })) {
                $null = $cpu.cores.Add([ordered]@{ core=$n; temp=$v; max=$vmax })
              }
            }
          }
          if ($type -eq "Load") {
            if ($name -match "CPU Total|Total" -and $cpu.load -eq $null) { $cpu.load = $v }
            elseif ($name -match "Core" -and $name -match "(\\d+)\\s*$") {
              $n = [int]$Matches[1]
              if (-not ($cpu.loads | Where-Object { $_.core -eq $n })) {
                $null = $cpu.loads.Add([ordered]@{ core=$n; load=$v })
              }
            }
          }
          if ($type -eq "Clock" -and $name -match "Core|Bus|CPU") {
            if ($name -match "(\\d+)\\s*$") {
              $n = [int]$Matches[1]
              if (-not ($cpu.clocks | Where-Object { $_.core -eq $n })) {
                $null = $cpu.clocks.Add([ordered]@{ core=$n; mhz=$v })
              }
            } else {
              $null = $cpu.clocks.Add([ordered]@{ core=-1; label=$name; mhz=$v })
            }
          }
          if ($type -eq "Power") {
            $null = $cpu.power.Add([ordered]@{ label=$name; watt=$v })
          }
          if ($type -eq "Fan") {
            $null = $cpu.fans.Add([ordered]@{ label=$name; rpm=$v })
          }
        }

        # ── GPU — collect everything flat ──
        if ($hwt -match "Gpu") {
          $gpu.name = $hw.Name
          $null = $gpu.sensors.Add([ordered]@{ name=$name; type=$type; value=$v; max=$vmax })
        }
      }
    }
  }

  $comp.Close()
  $method = "dll"
} catch {}

# ── WMI fallback ─────────────────────────────────────────────────────────────
if ($method -eq "none") {
  try {
    $wmiS = Get-WmiObject -Namespace "root\\LibreHardwareMonitor" -Class Sensor -ErrorAction Stop
    if ($wmiS) {
      foreach ($s in $wmiS) {
        if ($s.Value -eq $null) { continue }
        $v    = [math]::Round([double]$s.Value, 1)
        $name = $s.Name
        $type = $s.SensorType
        $hwt  = $s.Parent -replace "^/([^/]+).*",'$1'

        if ($hwt -match "cpu") {
          $cpu.name = ($s.Parent -split "/")[-2]
          if ($type -eq "Temperature") {
            if ($name -match "Package|Tdie|Tctl|CCD" -and $cpu.package -eq $null) { $cpu.package = $v }
            elseif ($name -match "Core" -and $name -match "(\\d+)\\s*$") {
              $n=[int]$Matches[1]
              if (-not ($cpu.cores|Where-Object{$_.core -eq $n})) {
                $null=$cpu.cores.Add([ordered]@{core=$n;temp=$v;max=$null})
              }
            }
          }
          if ($type -eq "Load") {
            if ($name -match "Total" -and $cpu.load -eq $null) { $cpu.load=$v }
            elseif ($name -match "Core" -and $name -match "(\\d+)\\s*$") {
              $n=[int]$Matches[1]
              if (-not ($cpu.loads|Where-Object{$_.core -eq $n})){$null=$cpu.loads.Add([ordered]@{core=$n;load=$v})}
            }
          }
          if ($type -eq "Clock" -and $name -match "Core" -and $name -match "(\\d+)\\s*$") {
            $n=[int]$Matches[1]
            if (-not ($cpu.clocks|Where-Object{$_.core -eq $n})){$null=$cpu.clocks.Add([ordered]@{core=$n;mhz=$v})}
          }
          if ($type -eq "Power"){$null=$cpu.power.Add([ordered]@{label=$name;watt=$v})}
          if ($type -eq "Fan")  {$null=$cpu.fans.Add([ordered]@{label=$name;rpm=$v})}
        }
        if ($hwt -match "gpu") {
          $null=$gpu.sensors.Add([ordered]@{name=$name;type=$type;value=$v;max=$null})
        }
      }
      try {
        $wH=Get-WmiObject -Namespace "root\\LibreHardwareMonitor" -Class Hardware -ErrorAction SilentlyContinue
        foreach($h in $wH){
          if($h.HardwareType -match "Cpu"){$cpu.name=$h.Name}
          if($h.HardwareType -match "Gpu"){$gpu.name=$h.Name}
        }
      } catch {}
      $method="wmi"
    }
  } catch {}
}

if ($method -eq "none") {
  Write-Output '{"error":"No sensor data. Run as Administrator or open LibreHardwareMonitor."}'
  exit
}

# Fallback package = max core temp
if ($cpu.package -eq $null -and $cpu.cores.Count -gt 0) {
  $cpu.package = ($cpu.cores | Measure-Object -Property temp -Maximum).Maximum
}

$cpu.cores  = @($cpu.cores  | Sort-Object core)
$cpu.loads  = @($cpu.loads  | Sort-Object core)
$cpu.clocks = @($cpu.clocks | Sort-Object core)

[ordered]@{ cpu=$cpu; gpu=$gpu; method=$method } | ConvertTo-Json -Depth 6 -Compress
`;

// ---------------------------------------------------------------------------
// Debug — all raw sensors
// ---------------------------------------------------------------------------
const PS_DEBUG = `
$ErrorActionPreference = "Stop"
try {
  Add-Type -Path "${DLL_PATH}"
  $comp = New-Object LibreHardwareMonitor.Hardware.Computer
  $comp.IsCpuEnabled=$true; $comp.IsGpuEnabled=$true; $comp.Open()
  $rows=[System.Collections.ArrayList]@()
  foreach ($hw in $comp.Hardware) {
    $hw.Update()
    foreach ($h in @($hw)+@($hw.SubHardware)) {
      if($h -ne $hw){$h.Update()}
      foreach ($s in $h.Sensors) {
        $null=$rows.Add([pscustomobject]@{hw=$hw.Name;hwType=$hw.HardwareType;sensor=$s.Name;type=$s.SensorType;value=$s.Value;max=$s.Max})
      }
    }
  }
  $comp.Close()
  $rows | ConvertTo-Json -Depth 3 -Compress
} catch {
  Write-Output "{\\"error\\":\\"$($_.Exception.Message)\\"}"
}
`;

function runPS(script) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ]);
    let out = '', err = '';
    ps.stdout.on('data', d => out += d);
    ps.stderr.on('data', d => err += d);
    ps.on('close', () => {
      const raw = out.trim();
      if (!raw) { resolve({ error: 'No PS output. Run as Administrator?' }); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) { resolve({ error: `Parse error: ${e.message}`, raw: raw.slice(0, 300) }); }
    });
    ps.on('error', e => resolve({ error: `Spawn failed: ${e.message}` }));
  });
}

// SSE
const clients = new Set();
app.get('/temps/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(': connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/temps', async (req, res) => res.json(lastData ?? await runPS(PS_SCRIPT)));
app.get('/debug', async (req, res) => res.json(await runPS(PS_DEBUG)));

let lastData = null;
async function poll() {
  const data = await runPS(PS_SCRIPT);
  lastData = data;
  if (data.error) {
    console.error('[poll]', data.error);
  } else {
    console.log(`[${data.method}] CPU:${data.cpu?.package ?? '?'}°C load:${data.cpu?.load ?? '?'}% | GPU:${data.gpu?.sensors?.find(s=>s.type==='Temperature')?.value ?? '?'}°C`);
  }
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } }
}

setInterval(poll, 2000);
poll();

app.listen(PORT, () => {
  console.log(`\n  PC Temp Monitor → http://localhost:${PORT}`);
  console.log(`  Debug sensors   → http://localhost:${PORT}/debug\n`);
});
