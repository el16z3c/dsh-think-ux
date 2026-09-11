# deploy.ps1 — deploy dsh-think-ux into a DSH install from this repo.
#
# Usage (from a shell; DSH sets $env:DSH_HOME to <root>\home\<version>):
#   powershell -File deploy.ps1
# Or explicit (no $env:DSH_HOME needed):
#   powershell -File deploy.ps1 -DshRoot 'C:\dsh' -Version '0.1.5-rc.2'
#
# What it does:
#   1. Copies this repo (the plugin source) byte-for-byte into
#        <root>\plugins\<plugin>            (upgrade-surviving source of truth)
#        <root>\versions\<ver>\plugins\<plugin>  (the copy the profile loads)
#   2. Verifies SHA256 parity across source and both destinations.
#   3. Checks the web profile cordis.patch.yml for the insert row and prints
#      the exact snippet to add if it is missing (it never edits the profile
#      itself — profile surgery is a human decision).

param(
	[string]$DshRoot,  # DSH install root (holds plugins\ and versions\).
	[string]$Version,  # version dir name under versions\ (and home\).
	[string]$Plugin = 'dsh-think-ux'
)
$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
if ($src -eq $null) { throw 'Run via: powershell -File <repo>\deploy.ps1' }

# --- resolve the install root ---------------------------------------------
if (-not $DshRoot) {
	# $env:DSH_HOME is <root>\home\<version>; derive <root> from it.
	if ($env:DSH_HOME) {
		$parts = $env:DSH_HOME -split '[\\/]'
		$idx = [Array]::IndexOf($parts, 'home')
		if ($idx -ge 1) {
			$DshRoot = ($parts[0..($idx - 1)] -join [IO.Path]::DirectorySeparatorChar)
		}
	}
	if (-not $DshRoot -or -not (Test-Path $DshRoot)) {
		throw "Cannot determine the DSH install root (DSH_HOME='$env:DSH_HOME'). Pass -DshRoot '<root>'."
	}
}

# --- resolve the version ---------------------------------------------------
if (-not $Version) {
	if ($env:DSH_HOME) { $Version = Split-Path $env:DSH_HOME -Leaf }
	if (-not $Version) {
		$cands = Get-ChildItem -Path (Join-Path $DshRoot 'versions') -Directory -ErrorAction SilentlyContinue
		if ($cands.Count -eq 1) { $Version = $cands[0].Name }
	}
	if (-not $Version) { throw "Cannot determine the version dir. Pass -Version '<ver>'." }
}

$dstTop   = Join-Path $DshRoot "plugins\$Plugin"
$dstVer   = Join-Path $DshRoot "versions\$Version\plugins\$Plugin"
$dsts = @($dstTop, $dstVer)
# Repo tooling that must never be deployed: deploy.ps1, .gitignore, .git dir.
$gitDir = (Join-Path $src '.git') + '\'
$IsPluginFile = { param($f) (@('deploy.ps1', '.gitignore') -notcontains $f.Name) -and -not $f.FullName.StartsWith($gitDir) }

Write-Output ("== source: {0} ==" -f $src)
Get-ChildItem -Path $src -Recurse -File | Where-Object { $IsPluginFile.Invoke($_) } | ForEach-Object {
	$rel = $_.FullName.Substring($src.Length + 1)
	Write-Output ("{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $rel)
}

foreach ($dst in $dsts) {
	Write-Output ("== deploying to {0} ==" -f $dst)
	New-Item -ItemType Directory -Path $dst -Force | Out-Null
		# deploy.ps1 / .git are tooling, not part of the deployed plugin.
	Get-ChildItem -Path $src -Recurse -File | Where-Object { $IsPluginFile.Invoke($_) } | ForEach-Object {
		$rel = $_.FullName.Substring($src.Length + 1)
		$target = Join-Path $dst $rel
		New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
		Copy-Item -Path $_.FullName -Destination $target -Force
	}
}

Write-Output '== parity check =='
$srcHashes = @{}
Get-ChildItem -Path $src -Recurse -File | Where-Object { $IsPluginFile.Invoke($_) } | ForEach-Object {
	$rel = $_.FullName.Substring($src.Length + 1)
	$srcHashes[$rel] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
}
$ok = $true
foreach ($dst in $dsts) {
	$dstHashes = @{}
	Get-ChildItem -Path $dst -Recurse -File | ForEach-Object {
		$rel = $_.FullName.Substring($dst.Length + 1)
		$dstHashes[$rel] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
	}
	foreach ($rel in $srcHashes.Keys) {
		$h = $dstHashes[$rel]
		$status = if ($h -and $h -eq $srcHashes[$rel]) { 'OK  ' } else { 'FAIL' }
		if ($h -ne $srcHashes[$rel]) { $ok = $false }
		Write-Output ("{0}  {1}  {2}" -f $status, $h, $rel)
	}
	foreach ($rel in $dstHashes.Keys) {
		if (-not $srcHashes.ContainsKey($rel)) {
			$ok = $false
			Write-Output ("FAIL  (stale file in destination, not in source)  {0}  {1}" -f $dstHashes[$rel], $rel)
		}
	}
}
if (-not $ok) { throw 'parity check FAILED' }
Write-Output 'ALL COPIES IDENTICAL'

# --- profile insert row ----------------------------------------------------
$profile = Join-Path $DshRoot "home\$Version\profiles\web\cordis.patch.yml"
$uri = 'file:///' + ($dstVer -replace '\\', '/') + '/lib/index.js'
if (-not (Test-Path $profile)) {
	Write-Output ("PROFILE: {0} not found — add the snippet below to the web profile used by this install." -f $profile)
} elseif (Select-String -Path $profile -Pattern ([regex]::Escape($Plugin)) -Quiet) {
	Write-Output ("PROFILE OK: insert row for '$Plugin' present in $profile")
} else {
	Write-Output ("PROFILE: insert row MISSING in $profile. Add:" -f $profile)
}
Write-Output '  - insert:'
Write-Output "      - id: $Plugin"
Write-Output "        name: $uri"

Write-Output ''
Write-Output 'Deploy complete. Refresh the GUI to load the plugin.'
