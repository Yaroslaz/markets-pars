@echo off
rem ===========================================================================
rem  "Vybiraem vmeste": browser extension installer / updater for Windows.
rem  Double-click this file. It downloads the extension from GitHub into
rem  %LOCALAPPDATA%\VybiraemVmeste\extension and shows what to click next.
rem  This batch part is ASCII only; the PowerShell code below is UTF-8 and is
rem  read by PowerShell itself, so Cyrillic text works on any code page.
rem  Nothing is written to the registry and no system settings are changed.
rem ===========================================================================
setlocal
set "VV_SELF=%~f0"
set "VV_ARGS=%*"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:VV_SELF,[Text.Encoding]::UTF8);$i=$t.IndexOf([string][char]10+'#'+'POWERSHELL');if($i -lt 0){Write-Host 'Installer file is damaged, please download it again.';exit 3};$sb=[ScriptBlock]::Create($t.Substring($i+1));Invoke-Expression ('& $sb '+$env:VV_ARGS);exit $LASTEXITCODE"
set "VV_CODE=%ERRORLEVEL%"
rem 2+ = PowerShell itself could not start the installer: keep the window open
if %VV_CODE% GEQ 2 pause
endlocal & exit /b %VV_CODE%

#POWERSHELL
# ---------------------------------------------------------------------------
# PowerShell 5.1+ part. Test switches (pass them to the .cmd file):
#   -Browser chrome|yandex|edge   choose the browser without asking
#   -NoLaunch                     never start a browser
#   -NoGui                        console instructions instead of the window
#   -NoPause                      do not wait for Enter at the end
#   -Local                        copy the extension folder next to this file
#                                 (..\ from extension\install) instead of GitHub
#   -Target <folder>              install somewhere else (for tests)
#   -GuiSnapshot <file.png>       render the helper window to a PNG and exit
# ---------------------------------------------------------------------------
param(
  [string]$Browser = '',
  [switch]$NoLaunch,
  [switch]$NoGui,
  [switch]$NoPause,
  [switch]$Local,
  [string]$Target = '',
  [string]$GuiSnapshot = '',
  [string]$ZipUrl = 'https://github.com/Yaroslaz/markets-pars/archive/refs/heads/main.zip'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) }
try { $Host.UI.RawUI.WindowTitle = 'Выбираем вместе — установка расширения' } catch {}

$AppTitle = 'Выбираем вместе'
$SiteUrl = 'https://yaroslaz.github.io/markets-pars/'
$HelpUrl = 'https://github.com/Yaroslaz/markets-pars/tree/main/extension/install'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Say([string]$Text = '', [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Wait-End {
  if (-not $NoPause) { Say; [void](Read-Host 'Нажмите Enter, чтобы закрыть это окно') }
}

function Set-ClipText([string]$Text) {
  try { Set-Clipboard -Value $Text; return $true } catch {}
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Clipboard]::SetText($Text)
    return $true
  } catch {}
  return $false
}

function Read-Manifest([string]$Folder) {
  $file = Join-Path $Folder 'manifest.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  try { return ([IO.File]::ReadAllText($file, $Utf8) | ConvertFrom-Json) } catch { return $null }
}

# --- 1. Get the extension files into a temporary folder -----------------------

function Get-FromGitHub([string]$Work) {
  $zip = Join-Path $Work 'main.zip'
  $out = Join-Path $Work 'extension'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {}
  Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Path $out -Force | Out-Null
  $root = [IO.Path]::GetFullPath($out).TrimEnd('\') + '\'
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      # markets-pars-main/extension/<file>, without the installer itself
      if ($name -notmatch '^[^/]+/extension/(.+)$') { continue }
      $rel = $Matches[1]
      if ($rel.EndsWith('/') -or $rel -match '^install(/|$)') { continue }
      $dest = [IO.Path]::GetFullPath((Join-Path $out ($rel.Replace('/', '\'))))
      if (-not $dest.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Подозрительный путь в архиве: $name" }
      New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
    }
  } finally { $archive.Dispose() }
  return $out
}

function Get-FromLocal([string]$Work, [string]$From) {
  $out = Join-Path $Work 'extension'
  New-Item -ItemType Directory -Path $out -Force | Out-Null
  Get-ChildItem -LiteralPath $From -Force | Where-Object { $_.Name -ne 'install' } |
    Copy-Item -Destination $out -Recurse -Force
  return $out
}

# --- 2. Put them into the stable folder the browser loads from ------------------

function Install-Files([string]$From, [string]$To, $NewManifest) {
  if (Test-Path -LiteralPath $To) {
    $hasFiles = [bool](Get-ChildItem -LiteralPath $To -Force | Select-Object -First 1)
    if ($hasFiles) {
      $old = Read-Manifest $To
      if (-not $old) {
        throw "Папка «$To» уже занята чем-то другим — не трогаю её. Запустите установку с ключом -Target и другой папкой."
      }
      Get-ChildItem -LiteralPath $To -Force | Remove-Item -Recurse -Force
    }
  } else {
    New-Item -ItemType Directory -Path $To -Force | Out-Null
  }
  Get-ChildItem -LiteralPath $From -Force | Copy-Item -Destination $To -Recurse -Force
}

# --- 3. Browsers ----------------------------------------------------------------

function Find-Browsers {
  $pf = $env:ProgramFiles; $pf86 = ${env:ProgramFiles(x86)}; $la = $env:LOCALAPPDATA
  $list = @(
    [pscustomobject]@{ Id = 'chrome'; Name = 'Google Chrome'; Short = 'Chrome'; Url = 'chrome://extensions'; Exe = $null
      Paths = @("$pf\Google\Chrome\Application\chrome.exe", "$pf86\Google\Chrome\Application\chrome.exe", "$la\Google\Chrome\Application\chrome.exe")
      AppPath = 'chrome.exe'; Match = 'Google\\Chrome'; ProgId = '^Chrome'
      DevMode = 'Включите переключатель «Режим разработчика» справа вверху страницы.'
      Button = 'Загрузить распакованное расширение' },
    [pscustomobject]@{ Id = 'yandex'; Name = 'Яндекс Браузер'; Short = 'Яндекс Браузер'; Url = 'browser://extensions'; Exe = $null
      Paths = @("$la\Yandex\YandexBrowser\Application\browser.exe", "$pf\Yandex\YandexBrowser\Application\browser.exe", "$pf86\Yandex\YandexBrowser\Application\browser.exe")
      AppPath = 'browser.exe'; Match = 'Yandex'; ProgId = '^Yandex'
      DevMode = 'Включите переключатель «Режим разработчика» справа вверху страницы.'
      Button = 'Загрузить распакованное расширение' },
    [pscustomobject]@{ Id = 'edge'; Name = 'Microsoft Edge'; Short = 'Edge'; Url = 'edge://extensions'; Exe = $null
      Paths = @("$pf86\Microsoft\Edge\Application\msedge.exe", "$pf\Microsoft\Edge\Application\msedge.exe", "$la\Microsoft\Edge\Application\msedge.exe")
      AppPath = 'msedge.exe'; Match = 'Microsoft\\Edge'; ProgId = '^MSEdge'
      DevMode = 'Включите переключатель «Режим разработчика» на панели слева (если панели не видно — разверните окно браузера).'
      Button = 'Загрузить распакованное' }
  )
  foreach ($b in $list) {
    $paths = @($b.Paths)
    foreach ($hive in 'HKCU:', 'HKLM:') {
      try {
        $p = (Get-ItemProperty -LiteralPath "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$($b.AppPath)" -ErrorAction Stop).'(default)'
        if ($p -and $p.Trim('"') -match $b.Match) { $paths += $p.Trim('"') }
      } catch {}
    }
    foreach ($p in $paths) {
      if ($p -and -not $p.StartsWith('\') -and (Test-Path -LiteralPath $p -PathType Leaf)) { $b.Exe = $p; break }
    }
  }
  return $list
}

function Get-DefaultBrowserId($List) {
  try {
    $progId = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop).ProgId
    foreach ($b in $List) { if ($b.Exe -and $progId -match $b.ProgId) { return $b.Id } }
  } catch {}
  return $null
}

function Start-Browser($B) {
  if ($NoLaunch -or -not $B.Exe) { return $false }
  # Browsers ignore chrome://, edge:// and browser:// addresses passed on the
  # command line (checked on Chrome 157, Edge 157, Yandex 26.10), so we just
  # bring the browser up and let the user paste the address.
  try { Start-Process -FilePath $B.Exe | Out-Null; return $true } catch { return $false }
}

# --- 4. Instructions -------------------------------------------------------------

function Show-ConsoleSteps($B, [string]$Path, [bool]$PathCopied) {
  Say
  Say "Осталось подключить расширение в браузере ($($B.Name)):" White
  Say
  Say "  1. Откройте новую вкладку, наберите в адресной строке  $($B.Url)  и нажмите Enter." Yellow
  Say "  2. $($B.DevMode)" Yellow
  Say "  3. Нажмите кнопку «$($B.Button)»." Yellow
  Say "  4. В окне выбора папки щёлкните в адресную строку вверху окна," Yellow
  Say "     нажмите Ctrl+V, затем Enter и кнопку «Выбор папки»." Yellow
  if ($PathCopied) { Say '     (путь к папке уже скопирован)' DarkGray }
  Say "     Путь к папке: $Path" DarkGray
  Say "  5. Готово! Если сайт «$AppTitle» был открыт — обновите его вкладку (F5)." Yellow
  Say
  Say 'Не удаляйте и не переносите эту папку: браузер берёт расширение из неё.'
  Say '«Режим разработчика» не выключайте — иначе браузер отключит расширение.'
  Say 'Обновление: запустите этот файл ещё раз, затем на странице расширений нажмите'
  Say "круговую стрелку «Обновить» на карточке «$AppTitle»."
}

function Show-HelperWindow($Browsers, [string]$SelectedId, [string]$Path, [string]$Version, [bool]$Updated) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $state = @{ B = ($Browsers | Where-Object { $_.Id -eq $SelectedId } | Select-Object -First 1) }
  $font = New-Object System.Drawing.Font('Segoe UI', 10)
  $bold = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $width = 470

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "$AppTitle — установка расширения"
  $form.Font = $font
  $form.TopMost = $true
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $true
  $form.AutoSize = $true
  $form.AutoSizeMode = 'GrowAndShrink'
  $form.BackColor = [System.Drawing.Color]::White
  $form.StartPosition = 'Manual'

  $flow = New-Object System.Windows.Forms.FlowLayoutPanel
  $flow.FlowDirection = 'TopDown'
  $flow.WrapContents = $false
  $flow.AutoSize = $true
  $flow.AutoSizeMode = 'GrowAndShrink'
  $flow.Padding = New-Object System.Windows.Forms.Padding(14, 10, 14, 12)
  $form.Controls.Add($flow)

  function New-Text([string]$Text, $Font = $font, [int]$Top = 6, $Color = $null) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Text; $l.Font = $Font; $l.AutoSize = $true
    $l.MaximumSize = New-Object System.Drawing.Size($width, 0)
    $l.Margin = New-Object System.Windows.Forms.Padding(0, $Top, 0, 0)
    if ($Color) { $l.ForeColor = $Color }
    $flow.Controls.Add($l); return $l
  }
  function New-Button([string]$Text, [scriptblock]$OnClick) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text; $b.AutoSize = $true; $b.AutoSizeMode = 'GrowAndShrink'
    $b.Padding = New-Object System.Windows.Forms.Padding(8, 2, 8, 2)
    $b.Margin = New-Object System.Windows.Forms.Padding(18, 4, 0, 2)
    $b.UseVisualStyleBackColor = $true
    $b.Add_Click($OnClick)
    $flow.Controls.Add($b); return $b
  }
  $green = [System.Drawing.Color]::FromArgb(0, 120, 60)
  $gray = [System.Drawing.Color]::FromArgb(90, 90, 90)

  $what = if ($Updated) { 'обновлено' } else { 'скачано' }
  [void](New-Text "Расширение «$AppTitle» $what (версия $Version)." $bold 0 $green)
  $intro = if ($Updated) {
    "Если расширение уже подключено в браузере, осталось только открыть страницу расширений (шаг 1) и нажать круговую стрелку «Обновить» на карточке «$AppTitle». Если ещё не подключено — пройдите все шаги, это делается один раз."
  } else {
    'Осталось подключить его в браузере — это делается один раз. Это окно будет поверх браузера, просто идите по шагам.'
  }
  [void](New-Text $intro $font 4 $gray)

  # browser choice (only when there is something to choose)
  $found = @($Browsers | Where-Object { $_.Exe })
  $choices = if ($found.Count -gt 0) { $found } else { @($Browsers) }
  $radios = @()
  if ($choices.Count -gt 1) {
    [void](New-Text 'Ваш браузер:' $bold 10)
    $row = New-Object System.Windows.Forms.FlowLayoutPanel
    $row.AutoSize = $true; $row.WrapContents = $false
    $row.Margin = New-Object System.Windows.Forms.Padding(14, 0, 0, 0)
    foreach ($c in $choices) {
      $r = New-Object System.Windows.Forms.RadioButton
      $r.Text = $c.Short; $r.Tag = $c.Id; $r.AutoSize = $true
      $r.Checked = ($c.Id -eq $state.B.Id)
      $row.Controls.Add($r); $radios += $r
    }
    $flow.Controls.Add($row)
  }

  $s1 = New-Text '' $font 10
  $open = New-Button '' { Invoke-Step1 }
  $s2 = New-Text '' $font 10
  $s3 = New-Text '' $font 10
  $s4 = New-Text '4. Откроется окно выбора папки. Нажмите кнопку ниже, затем в окне щёлкните в адресную строку вверху, нажмите Ctrl+V и Enter, затем «Выбор папки».' $font 10
  $copyPath = New-Button 'Скопировать путь к папке' {
    if (Set-ClipText $Path) { $copyPath.Text = 'Путь скопирован ✓ — вставьте его (Ctrl+V)' }
  }
  $pathBox = New-Object System.Windows.Forms.TextBox
  $pathBox.Text = $Path; $pathBox.ReadOnly = $true; $pathBox.BorderStyle = 'None'
  $pathBox.BackColor = [System.Drawing.Color]::White; $pathBox.ForeColor = $gray
  $pathBox.Multiline = $true; $pathBox.WordWrap = $true
  $pathBox.Width = $width - 18; $pathBox.Height = 2 * $font.Height + 4
  $pathBox.Margin = New-Object System.Windows.Forms.Padding(18, 2, 0, 0)
  $flow.Controls.Add($pathBox)
  [void](New-Text "5. Готово! В списке появится карточка «$AppTitle». Если сайт был открыт — обновите его вкладку (F5). Значок расширения можно закрепить через кусочек пазла справа от адресной строки." $font 10)
  [void](New-Text "Не удаляйте папку и не выключайте «Режим разработчика» — браузер берёт расширение из этой папки. Обновление: запустите этот файл ещё раз и нажмите круговую стрелку «Обновить» на карточке «$AppTitle»." $font 12 $gray)

  $closeRow = New-Object System.Windows.Forms.FlowLayoutPanel
  $closeRow.AutoSize = $true
  $closeRow.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
  $site = New-Object System.Windows.Forms.LinkLabel
  $site.Text = 'Открыть сайт «Выбираем вместе»'; $site.AutoSize = $true
  $site.Margin = New-Object System.Windows.Forms.Padding(0, 6, 40, 0)
  $site.Add_LinkClicked({ try { Start-Process $SiteUrl } catch {} })
  $close = New-Object System.Windows.Forms.Button
  $close.Text = 'Закрыть'; $close.AutoSize = $true
  $close.Add_Click({ $form.Close() })
  $closeRow.Controls.Add($site); $closeRow.Controls.Add($close)
  $flow.Controls.Add($closeRow)
  $form.CancelButton = $close

  function Invoke-Step1 {
    $b = $state.B
    $copied = Set-ClipText $b.Url
    $started = Start-Browser $b
    if ($copied) {
      $open.Text = if ($started) { "$($b.Short) открыт, адрес скопирован ✓" } else { 'Адрес скопирован ✓' }
    }
  }
  function Update-Steps {
    $b = $state.B
    $s1.Text = "1. Откройте страницу расширений: нажмите кнопку ниже, затем в браузере откройте новую вкладку (Ctrl+T), нажмите Ctrl+V и Enter. Адрес страницы: $($b.Url)"
    $open.Text = if ($b.Exe -and -not $NoLaunch) { "Открыть $($b.Short) и скопировать адрес" } else { 'Скопировать адрес страницы' }
    $s2.Text = "2. $($b.DevMode)"
    $s3.Text = "3. Нажмите появившуюся кнопку «$($b.Button)»."
    $copyPath.Text = 'Скопировать путь к папке'
  }
  foreach ($r in $radios) {
    $r.Add_CheckedChanged({
      param($sender, $e)
      if ($sender.Checked) { $state.B = $Browsers | Where-Object { $_.Id -eq $sender.Tag } | Select-Object -First 1; Update-Steps }
    })
  }
  Update-Steps

  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Add_Shown({
    $form.Location = New-Object System.Drawing.Point(([Math]::Max($area.Left, $area.Right - $form.Width - 16)), ($area.Top + 40))
    $form.Activate()
  })

  if ($GuiSnapshot) {
    $form.Add_Shown({
      $form.Refresh()
      $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
      $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
      $bmp.Save($GuiSnapshot, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      $form.Close()
    })
  }
  [void]$form.ShowDialog()
  $form.Dispose()
}

# --- Main ------------------------------------------------------------------------

$work = $null
$exitCode = 0
try {
  if ($Browser -and @('chrome', 'yandex', 'edge') -notcontains $Browser.ToLowerInvariant()) {
    throw "Неизвестный браузер «$Browser». Можно: chrome, yandex, edge."
  }
  Say
  Say "  $AppTitle — установка расширения для браузера" White
  Say '  ---------------------------------------------'
  Say

  $installRoot = Join-Path $env:LOCALAPPDATA 'VybiraemVmeste'
  $dest = if ($Target) { [IO.Path]::GetFullPath($Target) } else { Join-Path $installRoot 'extension' }
  $updated = [bool](Read-Manifest $dest)

  $work = Join-Path ([IO.Path]::GetTempPath()) ('VybiraemVmeste-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null

  $self = $env:VV_SELF
  $localExt = if ($self) { Split-Path -Parent (Split-Path -Parent $self) } else { '' }
  $hasLocal = $localExt -and (Test-Path -LiteralPath (Join-Path $localExt 'manifest.json') -PathType Leaf)

  $staged = $null
  if ($Local) {
    if (-not $hasLocal) { throw 'Ключ -Local: рядом с этим файлом нет папки расширения (..\manifest.json).' }
    Say "Беру расширение из папки рядом: $localExt"
    $staged = Get-FromLocal $work $localExt
  } else {
    Say 'Скачиваю свежую версию с GitHub…'
    try {
      $staged = Get-FromGitHub $work
    } catch {
      if (-not $hasLocal) { throw "Не удалось скачать расширение: $($_.Exception.Message)`nПроверьте интернет и запустите файл ещё раз." }
      Say "Скачать не получилось ($($_.Exception.Message))." DarkYellow
      Say "Беру расширение из папки рядом: $localExt" DarkYellow
      Remove-Item -LiteralPath (Join-Path $work 'extension') -Recurse -Force -ErrorAction SilentlyContinue
      $staged = Get-FromLocal $work $localExt
    }
  }

  $manifest = Read-Manifest $staged
  if (-not $manifest -or $manifest.manifest_version -ne 3 -or -not $manifest.name) {
    throw 'Скачанные файлы не похожи на расширение (нет правильного manifest.json).'
  }

  Install-Files $staged $dest $manifest
  if (-not (Read-Manifest $dest)) { throw "Не удалось записать файлы в папку «$dest»." }
  $what = if ($updated) { 'обновлено' } else { 'установлено' }
  Say "Готово: расширение «$($manifest.name)» версии $($manifest.version) $what в папку" Green
  Say "  $dest" Green

  $browsers = Find-Browsers
  $found = @($browsers | Where-Object { $_.Exe })
  if ($Browser) {
    $selected = $browsers | Where-Object { $_.Id -eq $Browser.ToLowerInvariant() } | Select-Object -First 1  } else {
    $defId = Get-DefaultBrowserId $browsers
    $selected = if ($defId) { $browsers | Where-Object { $_.Id -eq $defId } | Select-Object -First 1 }
                elseif ($found.Count -gt 0) { $found[0] } else { $browsers[0] }
  }
  if ($found.Count -eq 0) { Say 'Chrome, Яндекс Браузер или Edge не найдены — покажу общие шаги.' DarkYellow }

  $guiShown = $false
  if (-not $NoGui) {
    try {
      if ($updated -and -not $GuiSnapshot) {
        Say
        Say 'Если расширение уже было подключено, осталось одно: на странице расширений' White
        Say "нажмите круговую стрелку «Обновить» на карточке «$AppTitle»." White
      }
      Say
      Say 'Открываю окно с подсказками…'
      Show-HelperWindow $browsers $selected.Id $dest ([string]$manifest.version) $updated
      $guiShown = $true
    } catch {
      Say "Окно с подсказками не открылось ($($_.Exception.Message)), пишу шаги здесь." DarkYellow
    }
  }
  if (-not $guiShown) {
    $copied = Set-ClipText $dest
    if (-not $GuiSnapshot) { [void](Start-Browser $selected) }
    Show-ConsoleSteps $selected $dest $copied
    Wait-End
  }
} catch {
  $exitCode = 1
  Say
  Say 'Установка не получилась:' Red
  Say "  $($_.Exception.Message)" Red
  Say
  Say "Подробная инструкция: $HelpUrl"
  Wait-End
} finally {
  if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
exit $exitCode
