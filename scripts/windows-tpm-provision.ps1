# Creates only a local, non-exportable TPM credential and its public certificate.
# Cloud service-account creation, public-key upload and IAM grants are separate.
[CmdletBinding(DefaultParameterSetName = 'Create')]
param(
    [Parameter(ParameterSetName = 'Create')]
    [string]$OutputDirectory,
    [Parameter(ParameterSetName = 'Create')]
    [int]$ValidityYears = 5,
    [Parameter(ParameterSetName = 'Inspect')]
    [switch]$InspectOnly,
    [Parameter(ParameterSetName = 'Inspect')]
    [string]$CertificateThumbprint
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedProvider = 'Microsoft Platform Crypto Provider'
$safeFailure = 'TPM provisioning failed. No private key was exported. Preserve any output directory and inspect provisioning-state.jsonl and the CurrentUser certificate store before retrying; partial state may exist.'
$journal = $null
$certificate = $null
$privateRsa = $null
$publicRsa = $null

function Assert-LocalDirectoryPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '[\r\n\0]') { throw 'Invalid output path' }
    $absolute = [System.IO.Path]::GetFullPath($Value)
    if ($absolute -eq [System.IO.Path]::GetPathRoot($absolute)) { throw 'Output cannot be a volume root' }
    if ([System.IO.File]::Exists($absolute) -or [System.IO.Directory]::Exists($absolute)) { throw 'Output must be new' }
    $parent = [System.IO.DirectoryInfo]::new([System.IO.Path]::GetDirectoryName($absolute))
    if (-not $parent.Exists) { throw 'Output parent must exist' }
    # Refuse junctions and symlinks before creating anything in the chosen path.
    for ($ancestor = $parent; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
        if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse path is not supported' }
    }
    return $absolute
}

function Write-NewPublicFile([string]$Path, [string]$Contents) {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

function Write-ProvisioningEvent($Stream, $Event) {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($Event | ConvertTo-Json -Compress -Depth 4) + "`n")
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush($true)
}

function Assert-TpmCertificate($Cert, $Rsa) {
    if (-not $Cert.HasPrivateKey -or $Rsa -isnot [System.Security.Cryptography.RSACng]) { throw 'Expected CNG private key' }
    if ($Rsa.Key.Provider.Provider -cne $expectedProvider -or $Rsa.KeySize -ne 2048) { throw 'Expected TPM RSA2048 key' }
    if ($Rsa.Key.ExportPolicy -ne [System.Security.Cryptography.CngExportPolicies]::None) { throw 'Key must be non-exportable' }
    if ($Rsa.Key.IsMachineKey -or $Rsa.Key.IsEphemeral) { throw 'Expected persistent current-user key' }
    if ($Rsa.Key.UIPolicy.ProtectionLevel -ne [System.Security.Cryptography.CngUIProtectionLevels]::None) { throw 'Key requires interactive protection' }
    $now = [DateTime]::UtcNow
    if ($Cert.NotBefore.ToUniversalTime() -gt $now -or $Cert.NotAfter.ToUniversalTime() -le $now) { throw 'Certificate is not currently valid' }
    $usage = @($Cert.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension] })
    if ($usage.Count -ne 1 -or ($usage[0].KeyUsages -band [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) -eq 0) { throw 'Certificate must allow signatures' }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required' }
    if ($InspectOnly) {
        if ($CertificateThumbprint -cnotmatch '^[A-Fa-f0-9]{40}$') { throw 'Invalid thumbprint' }
        $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $CertificateThumbprint.ToUpperInvariant())
        $privateRsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
        Assert-TpmCertificate $certificate $privateRsa
        [Console]::Out.WriteLine(([ordered]@{
            version = 1; certificateThumbprint = $certificate.Thumbprint; provider = $expectedProvider
            keySize = $privateRsa.KeySize; exportable = $false; certificateStore = 'CurrentUser/My'
            notBefore = $certificate.NotBefore.ToUniversalTime().ToString('o')
            notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
            daysUntilExpiry = [Math]::Floor(($certificate.NotAfter.ToUniversalTime() - [DateTime]::UtcNow).TotalDays)
            signVerifyPerformed = $false; credentialCreated = $false
        } | ConvertTo-Json -Compress))
        exit 0
    }

    if ($PSBoundParameters.ContainsKey('CertificateThumbprint') -or $ValidityYears -lt 1 -or $ValidityYears -gt 5) { throw 'Invalid provisioning options' }
    $destination = Assert-LocalDirectoryPath $OutputDirectory
    if ($null -eq (Get-Command New-SelfSignedCertificate -ErrorAction SilentlyContinue)) { throw 'Certificate provisioning is unavailable' }
    $container = 'plytix-mcp-' + [Guid]::NewGuid().ToString('N')
    $createdAt = [DateTime]::UtcNow
    $notAfter = $createdAt.AddYears($ValidityYears)
    # New-Item without Force reserves the destination and fails if it already
    # exists. Any interrupted attempt keeps this directory to prevent retries.
    $null = New-Item -ItemType Directory -Path $destination -ErrorAction Stop
    $journalPath = [System.IO.Path]::Combine($destination, 'provisioning-state.jsonl')
    $journal = [System.IO.File]::Open($journalPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    Write-ProvisioningEvent $journal ([ordered]@{
        version = 1; phase = 'reserved'; keyContainer = $container; certificateStore = 'CurrentUser/My'
        createdAt = $createdAt.ToString('o'); requestedNotAfter = $notAfter.ToString('o')
    })
    $parameters = @{
        Type = 'Custom'; Subject = 'CN=Plytix MCP connector'; FriendlyName = 'Plytix MCP connector ' + $container
        Provider = $expectedProvider; Container = $container; KeyAlgorithm = 'RSA'; KeyLength = 2048
        KeyExportPolicy = 'NonExportable'; KeyUsage = 'DigitalSignature'; KeyUsageProperty = 'Sign'
        KeyProtection = 'None'; HashAlgorithm = 'SHA256'; CertStoreLocation = 'Cert:\CurrentUser\My'
        NotBefore = $createdAt.AddMinutes(-5); NotAfter = $notAfter
    }
    $certificate = New-SelfSignedCertificate @parameters
    # Retain the returned thumbprint before validation/export can fail. If the
    # provider fails before returning, the reserved container still identifies
    # the attempted key for deliberate recovery; do not delete/recreate blindly.
    Write-ProvisioningEvent $journal ([ordered]@{
        version = 1; phase = 'certificate-created'; certificateThumbprint = $certificate.Thumbprint
        keyContainer = $container; certificateStore = 'CurrentUser/My'
    })
    $privateRsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
    Assert-TpmCertificate $certificate $privateRsa
    $publicRsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
    $challenge = [System.Text.Encoding]::UTF8.GetBytes('Plytix MCP local TPM provisioning verification: ' + $container)
    $signature = $privateRsa.SignData($challenge, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    if (-not $publicRsa.VerifyData($challenge, $signature, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)) { throw 'Signature verification failed' }
    $certificatePath = [System.IO.Path]::Combine($destination, 'certificate.pem')
    # RawData contains only the public X.509 certificate. No private-key export
    # API is used, and the provider policy independently prohibits export.
    $base64 = [Convert]::ToBase64String($certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks)
    Write-NewPublicFile $certificatePath ("-----BEGIN CERTIFICATE-----`r`n" + $base64 + "`r`n-----END CERTIFICATE-----`r`n")
    $metadata = [ordered]@{
        version = 1; certificateThumbprint = $certificate.Thumbprint; provider = $expectedProvider
        keySize = $privateRsa.KeySize; exportable = $false; certificateStore = 'CurrentUser/My'
        notBefore = $certificate.NotBefore.ToUniversalTime().ToString('o')
        notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
        certificatePath = $certificatePath; signVerifyPassed = $true; credentialCreated = $true
    }
    Write-NewPublicFile ([System.IO.Path]::Combine($destination, 'identity-public.json')) (($metadata | ConvertTo-Json -Depth 4) + "`n")
    Write-ProvisioningEvent $journal ([ordered]@{ version = 1; phase = 'complete'; certificateThumbprint = $certificate.Thumbprint; signVerifyPassed = $true })
    [Console]::Out.WriteLine(($metadata | ConvertTo-Json -Compress))
} catch {
    [Console]::Error.WriteLine($safeFailure)
    exit 1
} finally {
    if ($null -ne $publicRsa) { $publicRsa.Dispose() }
    if ($null -ne $privateRsa) { $privateRsa.Dispose() }
    if ($null -ne $certificate) { $certificate.Dispose() }
    if ($null -ne $journal) { $journal.Dispose() }
}
