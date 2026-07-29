const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
const PORT = 3000;

// Enable CORS for Netlify frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Serve frontend from Netlify, or local if available
app.use(express.static(path.join(__dirname, 'public')));

const DLL_PATH = path.join(__dirname, 'Libre', 'LibreHardwareMonitorLib.dll');

// PowerShell script to collect temps
const PS_SCRIPT = (dllPath) => `
$ErrorActionPreference = "SilentlyContinue"
$DebugPreference = "SilentlyContinue"
$method = "none"

$cpu = [ordered]@{
  name    = "CPU"
  package = $null; packageMax = $null
  cores   = [System.Collections.ArrayList]@()
  load    = $null; loads = [System.Collections.ArrayList]@()
  clocks  = [System.Collections.ArrayList]@()
  power   = [System.Collections.ArrayList]@()
}
$gpu = [ordered]@{
  name    = "GPU"
  sensors = [System.Collections.ArrayList]@()
}

# Try DLL
try {
  if (Test-Path "${dllPath}") {
    Add-Type -Path "${dllPath}" -ErrorAction Stop
    $comp = New-Object LibreHardwareMonitor.Hardware.Computer
    $comp.IsCpuEnabled = $true
    $comp.IsGpuEnabled = $true
    $comp.Open()

    foreach ($hw in $comp.Hardware) {
      $hw.Update()
      foreach ($h in @($hw) + @($hw.SubHardware)) {
        if ($h -ne $hw) { $h.Update() }
        foreach ($s in $h.Sensors) {
          if ($s.Value -eq $null) { continue }
          $v = [math]::Round([double]$s.Value, 1)
          $vmax = if ($s.Max) { [math]::Round([double]$s.Max, 1) } else { $null }
          $type = $s.SensorType.ToString()
          $hwt = $h.HardwareType.ToString()
          $name = $s.Name

          if ($hwt -match "Cpu") {
            $cpu.name = $hw.Name
            if ($type -eq "Temperature") {
              if ($name -match "Package|Tdie|Tctl|CCD" -and $cpu.package -eq $null) {
                $cpu.package = $v; $cpu.packageMax = $vmax
              } elseif ($name -match "Core" -and $name -match "(\\d+)") {
                $n = [int]$Matches[1]
                if (-not ($cpu.cores | ? { $_.core -eq $n })) {
                  $null = $cpu.cores.Add(@{core=$n; temp=$v; max=$vmax})
                }
              }
            }
            if ($type -eq "Load") {
              if ($name -match "Total" -and $cpu.load -eq $null) { $cpu.load = $v }
              elseif ($name -match "Core" -and $name -match "(\\d+)") {
                $n = [int]$Matches[1]
                if (-not ($cpu.loads | ? { $_.core -eq $n })) {
                  $null = $cpu.loads.Add(@{core=$n; load=$v})
                }
              }
            }
            if ($type -eq "Clock" -and $name -match "Core|CPU") {
              if ($name -match "(\\d+)") {
                $n = [int]$Matches[1]
                if (-not ($cpu.clocks | ? { $_.core -eq $n })) {
                  $null = $cpu.clocks.Add(@{core=$n; mhz=$v})
                }
              }
            }
            if ($type -eq "Power") {
              $null = $cpu.power.Add(@{label=$name; watt=$v})
            }
          }
          if ($hwt -match "Gpu") {
            $gpu.name = $hw.Name
            $null = $gpu.sensors.Add(@{name=$name; type=$type; value=$v; max=$vmax})
          }
        }
      }
    }
    $comp.Close()
    $method = "dll"
  }
} catch { }

if ($cpu.package -eq $null -and $cpu.cores.Count -gt 0) {
  $cpu.package = ($cpu.cores | Measure-Object -Property temp -Maximum).Maximum
}

$cpu.cores = @($cpu.cores | Sort-Object core)
$cpu.loads = @($cpu.loads | Sort-Object core)
$cpu.clocks = @($cpu.clocks | Sort-Object core)

[ordered]@{ cpu=$cpu; gpu=$gpu; method=$method } | ConvertTo-Json -Depth 6 -Compress
`;

function runPS(script) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true });
    let out = '', err = '';
    ps.stdout.on('data', d => out += d);
    ps.stderr.on('data', d => err += d);
    ps.on('close', () => {
      const raw = out.trim();
      if (!raw) { resolve({ error: 'No output' }); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) { resolve({ error: `Parse: ${e.message}` }); }
    });
    ps.on('error', e => resolve({ error: `Spawn: ${e.message}` }));
  });
}

const clients = new Set();
app.get('/temps/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/temps', async (req, res) => res.json(lastData || {}));

let lastData = null;
async function poll() {
  const data = await runPS(PS_SCRIPT(DLL_PATH));
  lastData = data;
  if (data.error) {
    console.error('[poll]', data.error);
  } else {
    console.log(`[${data.method || '?'}] CPU:${data.cpu?.package ?? '?'}°C | GPU:${data.gpu?.sensors?.[0]?.value ?? '?'}°C`);
  }
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } }
}

setInterval(poll, 2000);
poll();

app.listen(PORT, () => {
  console.log(`\n  PC Temp Monitor → http://localhost:${PORT}\n`);
});
