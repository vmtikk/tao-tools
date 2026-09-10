Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $name, $value = $_ -split '=', 2
    Set-Item -Path "env:$($name.Trim())" -Value $value.Trim()
}

pnpm.cmd --filter @tao-tools/pipeline run chain:materialize-silver *>&1 | Tee-Object -FilePath materialize-silver.log
