# The only successful output is a signed assertion for the parent's private pipe.
# Never run this signer interactively or add transcript/debug logging.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$store = $null
$rsa = $null
$certificate = $null
try {
    $buffer = New-Object char[] 1024
    $inputBuilder = New-Object System.Text.StringBuilder
    while (($count = [Console]::In.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if (($inputBuilder.Length + $count) -gt 16384) { throw 'Invalid input' }
        [void]$inputBuilder.Append($buffer, 0, $count)
    }
    $request = $inputBuilder.ToString() | ConvertFrom-Json
    $names = @($request.PSObject.Properties.Name)
    $allowed = @('version', 'type', 'serviceAccount', 'keyId', 'certificateThumbprint', 'audience', 'issuedAt', 'expiresAt')
    if ($names.Count -ne $allowed.Count -or @($names | Where-Object { $_ -notin $allowed }).Count -ne 0) { throw 'Invalid input' }
    if ($request.version -cne 1 -or $request.type -cne 'windows-tpm' -or
        $request.serviceAccount -cnotmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$' -or
        $request.keyId -cnotmatch '^[a-fA-F0-9]{40}$' -or
        $request.certificateThumbprint -cnotmatch '^[a-fA-F0-9]{40}$') { throw 'Invalid input' }
    $audience = [Uri]$request.audience
    if ($audience.Scheme -cne 'https' -or $audience.UserInfo -or $audience.Query -or $audience.Fragment -or
        $audience.GetLeftPart([UriPartial]::Authority) -cne $request.audience -or $request.audience.Length -gt 2048) { throw 'Invalid input' }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($request.issuedAt -isnot [long] -and $request.issuedAt -isnot [int]) { throw 'Invalid input' }
    if ($request.expiresAt -isnot [long] -and $request.expiresAt -isnot [int]) { throw 'Invalid input' }
    if ([Math]::Abs($now - $request.issuedAt) -gt 60 -or $request.expiresAt -ne ($request.issuedAt + 300)) { throw 'Invalid input' }

    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    $certificateMatches = @($store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $request.certificateThumbprint, $false))
    if ($certificateMatches.Count -ne 1) { throw 'Invalid certificate' }
    $certificate = $certificateMatches[0]
    if (-not $certificate.HasPrivateKey -or $certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or
        $certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) { throw 'Invalid certificate' }
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
    if ($rsa -isnot [System.Security.Cryptography.RSACng] -or $rsa.KeySize -lt 2048 -or
        $rsa.Key.Provider.Provider -cne 'Microsoft Platform Crypto Provider' -or
        $rsa.Key.ExportPolicy -ne [System.Security.Cryptography.CngExportPolicies]::None -or
        $rsa.Key.IsMachineKey -or $rsa.Key.IsEphemeral -or
        $rsa.Key.UIPolicy.ProtectionLevel -ne [System.Security.Cryptography.CngUIProtectionLevels]::None) { throw 'Invalid key provider' }

    function ConvertTo-Base64Url([byte[]]$Bytes) {
        return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    $header = [ordered]@{ alg = 'RS256'; typ = 'JWT'; kid = $request.keyId } | ConvertTo-Json -Compress
    $claims = [ordered]@{
        iss = $request.serviceAccount
        aud = 'https://oauth2.googleapis.com/token'
        target_audience = $request.audience
        iat = $request.issuedAt
        exp = $request.expiresAt
    } | ConvertTo-Json -Compress
    $signingInput = (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($header))) + '.' + (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($claims)))
    $signature = $rsa.SignData([Text.Encoding]::UTF8.GetBytes($signingInput), [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    [Console]::Out.WriteLine($signingInput + '.' + (ConvertTo-Base64Url $signature))
} catch {
    [Console]::Error.WriteLine('Windows TPM signing failed.')
    exit 1
} finally {
    if ($null -ne $rsa) { $rsa.Dispose() }
    if ($null -ne $certificate) { $certificate.Dispose() }
    if ($null -ne $store) { $store.Dispose() }
}
