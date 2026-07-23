# curl-impersonate (Firefly bot bypass)

Firefly istekleri Firefox TLS + HTTP/2 fingerprint ile gider.

## Kurulum (Windows x64)

```powershell
$dir = "tools\curl-impersonate"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$url = "https://github.com/lexiforest/curl-impersonate/releases/download/v1.5.6/libcurl-impersonate-v1.5.6.x86_64-win32.tar.gz"
Invoke-WebRequest $url -OutFile "$dir\pkg.tar.gz"
tar -xzf "$dir\pkg.tar.gz" -C $dir
Invoke-WebRequest "https://curl.se/ca/cacert.pem" -OutFile "$dir\cacert.pem"
```

`.env.local` içine:

```
FIREFLY_CURL_IMPERSONATE=<proje>\tools\curl-impersonate\bin\curl-impersonate.exe
```

Path verilmezse kod aynı `tools/curl-impersonate/bin/curl-impersonate.exe` yolunu otomatik dener.

## Doğrulama

Log'da şunu görmelisin:

```
>> Firefly HTTP: curl-impersonate (Firefox135 TLS/H2) → ...
```
