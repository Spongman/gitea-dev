#!/bin/sh
# Installs the Gitea Web IDE release (npm run build or npm run package) into $GITEA_CUSTOM without Node.
# Needs a POSIX shell and utilities. --workbench=download and local also need tar, gzip and one of
# sha256sum, shasum or openssl; download also needs curl or wget.
set -eu
export LC_ALL=C

usage='Usage: install GITEA_CUSTOM ROOT_URL [--oauth-client-id=ID] [--webviews=disabled|vscode-cdn]
  [--connect-src="SOURCE ..."] [--extensions-allowlist="PUBLISHER.NAME ..."] [--gallery=URL|off]
  [--workbench=cdn|download|local] [--workbench-archive=PATH] [--app-ini=PATH]'
cors_lines='[cors]
ENABLED = true
ALLOW_DOMAIN = https://*.vscode-cdn.net
METHODS = GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS
HEADERS = Content-Type,User-Agent,Authorization
ALLOW_CREDENTIALS = false'
url_expected='an https URL, or http on localhost, 127.0.0.1 or [::1], with a lowercase host and a plain path'
die() { printf '%s\n' "$1" >&2; exit 1; }
nl='
'
tab=$(printf '\t')
# Problems are collected and reported together, one line each; notes say which checks were skipped.
problems='' cors_problems='' notes='' usage_needed=0
problem() { problems="$problems$1$nl"; }
cors_problem() { cors_problems="$cors_problems$1$nl"; }
note() { notes="${notes}Note: $1$nl"; }
# A found value in a message: quoted, on one line.
show() { printf '"%s"' "$(printf '%s' "$1" | tr '\n' ' ')"; }

here=$(cd "$(dirname "$0")" && pwd)
ASSETS=public/assets/gitea-dev
IFRAME=workbench/out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html
OPEN_VSX=https://open-vsx.org
# Open VSX redirects file downloads to this host.
OPEN_VSX_CONTENT=https://openvsx.eclipsecontent.org
# Microsoft's CDN serves each workbench build at /stable/<commit>/; extension hosts run on its subdomains.
CDN=https://main.vscode-cdn.net
CDN_FRAMES='https://*.vscode-cdn.net'
# An origin of the form the CDN extension host has, for the CORS checks.
CDN_ORIGIN=https://v--gitea-dev-install-check.vscode-cdn.net
# Validation patterns (grep -E).
URL_RE='^(https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?|http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?)(/[A-Za-z0-9._~-]+)*/?$'
SOURCE_RE='^((https|wss)://(\*\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)|(http|ws)://(localhost|127\.0\.0\.1|\[::1\]))(:([0-9]{1,5}|\*))?(/[A-Za-z0-9._~/-]*)?$'
DOTS_RE='/\.\.?(/|$)'
ID_RE='^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$'
CLIENT_ID_RE='^[A-Za-z0-9-]{1,128}$'
VERSION_RE='^[0-9a-f]{12}-[0-9a-f]{12}$'
COMMIT_RE='^[0-9a-f]{40}$'
SHA256_RE='^[0-9a-f]{64}$'

# Single-line match only, so an embedded newline cannot smuggle a second line past the pattern.
matches() { [ "$(printf '%s' "$1" | wc -l)" -eq 0 ] && printf '%s\n' "$1" | grep -Eq "$2"; }
valid_url() { matches "$1" "$URL_RE" && ! matches "$1" "$DOTS_RE"; }
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1"
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r < "$1"
  else die 'Needs sha256sum, shasum or openssl'
  fi | sed 's/[^0-9a-f].*$//'
}
# CSP source of each inline <script> body of $1, space-separated, in document order.
script_hashes() {
  count=$(awk -v out="$scratch/script" '
    { text = text (NR > 1 ? "\n" : "") $0 }
    END {
      n = 0
      while ((i = index(text, "<script>")) > 0) {
        text = substr(text, i + 8)
        j = index(text, "</script>")
        if (j == 0) break
        n++
        printf "%s", substr(text, 1, j - 1) > (out "." n)
        close(out "." n)
        text = substr(text, j + 9)
      }
      print n
    }' "$1")
  hashes='' i=1
  while [ "$i" -le "$count" ]; do
    hashes="${hashes:+$hashes }'sha256-$(sha256_hex "$scratch/script.$i" | hex_to_base64)'"
    i=$((i + 1))
  done
  printf '%s' "$hashes"
}
hex_to_base64() {
  awk '{
    digits = "0123456789abcdef"
    b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    out = ""
    for (i = 1; i <= length($0); i += 6) {
      chunk = substr($0, i, 6)
      v = 0
      for (j = 1; j <= 6; j++) v = v * 16 + (j <= length(chunk) ? index(digits, substr(chunk, j, 1)) - 1 : 0)
      bytes = length(chunk) / 2
      out = out substr(b64, int(v / 262144) % 64 + 1, 1) substr(b64, int(v / 4096) % 64 + 1, 1)
      out = out (bytes > 1 ? substr(b64, int(v / 64) % 64 + 1, 1) : "=") (bytes > 2 ? substr(b64, v % 64 + 1, 1) : "=")
    }
    print out
  }'
}

# Value of KEY in [SECTION] of an app.ini, read as Gitea's ini parser does for plain values (last one
# wins; "=" or ":" delimits; a quoted value ends at its closing quote, else "#" or ";" starts a comment).
ini_value() {
  awk -v section="$2" -v key="$3" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    {
      line = $0; sub(/\r$/, "", line); sub(/^[ \t]+/, "", line)
      first = substr(line, 1, 1)
      if (line == "" || first == "#" || first == ";") next
      if (first == "[") {
        end = index(line, "]")
        current = trim(end ? substr(line, 2, end - 2) : substr(line, 2))
        next
      }
      at = match(line, /[=:]/)
      if (current != section || at == 0) next
      name = substr(line, 1, at - 1); sub(/[ \t]+$/, "", name)
      if (name != key) next
      rest = substr(line, at + 1); sub(/^[ \t]+/, "", rest)
      quote = substr(rest, 1, 1); stop = 0
      if (quote == "\"" || quote == "`") stop = index(substr(rest, 2), quote)
      if (stop > 0) value = substr(rest, 2, stop - 1)
      else { value = rest; sub(/[#;].*$/, "", value); sub(/[ \t]+$/, "", value) }
    }
    END { printf "%s", value }' "$1"
}
# Comma-separated list, trimmed and lowercased, one item per line.
list_of() { printf '%s\n' "$1" | tr ',' '\n' | sed "s/^[ $tab]*//; s/[ $tab]*\$//" | tr '[:upper:]' '[:lower:]' | grep -v '^$' || true; }
# Whether a Gitea [cors] ALLOW_DOMAIN entry admits the CDN origin (go-chi/cors: one "*" wildcard).
allows_cdn() {
  case $1 in
    *'*'*) prefix=${1%%\**} suffix=${1#*\*}
      case $CDN_ORIGIN in "$prefix"*"$suffix") return 0 ;; esac
      return 1 ;;
    *) [ "$1" = "$CDN_ORIGIN" ] ;;
  esac
}
# Value of header $2 (lowercase) in the response headers $1.
header_value() {
  printf '%s\n' "$1" | tr -d '\r' | awk -v name="$2" '
    index(tolower($0), name ":") == 1 { v = substr($0, length(name) + 2); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v) }
    END { printf "%s", v }'
}
# Checks of the app.ini Gitea reads: ROOT_URL, and for --workbench=cdn the [cors] section.
check_app_ini() {
  ini_root=$(ini_value "$1" server ROOT_URL)
  case $ini_root in
    '' | *'%('*) note "$1 sets no literal [server] ROOT_URL; skipped comparing it with ROOT_URL." ;;
    *) if [ -n "$instance" ] && [ "${ini_root%/}" != "$instance" ]; then
         problem "ROOT_URL: got $(show "$instance"); $1 has [server] ROOT_URL = $ini_root; pass that URL."
       fi ;;
  esac
  [ "$workbench" = cdn ] || return 0
  enabled=$(ini_value "$1" cors ENABLED)
  case $(printf '%s' "$enabled" | tr '[:upper:]' '[:lower:]') in
    1 | t | true | y | yes | on) ;;
    *) cors_problem "$1 [cors] ENABLED: got $(show "$enabled"); --workbench=cdn needs true." ;;
  esac
  domains=$(ini_value "$1" cors ALLOW_DOMAIN)
  if [ -n "$domains" ]; then
    allowed=0
    set -f
    for entry in $(list_of "$domains"); do if allows_cdn "$entry"; then allowed=1; fi; done
    set +f
    [ "$allowed" = 1 ] || cors_problem "$1 [cors] ALLOW_DOMAIN: got $(show "$domains"); expected it to allow https://*.vscode-cdn.net."
  fi
  # The API adds Authorization itself (Gitea routers/api/v1/api.go); the OAuth token request sends Content-Type.
  headers=$(ini_value "$1" cors HEADERS)
  if [ -n "$headers" ] && ! list_of "$headers" | grep -qx -e '\*' -e 'content-type'; then
    cors_problem "$1 [cors] HEADERS: got $(show "$headers"); expected it to include Content-Type."
  fi
}
# Online checks against the running Gitea at ROOT_URL; skipped with a note when it does not answer.
check_gitea() {
  skipped="the online checks of ROOT_URL"
  [ "$workbench" != cdn ] || skipped="$skipped, [cors]"
  [ -z "$checked_client_id" ] || skipped="$skipped and --oauth-client-id"
  if ! command -v curl >/dev/null 2>&1; then note "curl not found; skipped $skipped."; return 0; fi
  if ! response=$(curl -s -m 10 -w '\n%{http_code}' "$instance/api/v1/version" 2>/dev/null); then
    note "Gitea is not reachable at $instance/api/v1/version; skipped $skipped."
    return 0
  fi
  status=$(printf '%s\n' "$response" | tail -n 1)
  # A reverse proxy in front of a stopped Gitea (an install before the first start).
  case $status in
    502 | 503 | 504) note "$instance/api/v1/version answered HTTP $status, so Gitea is not running behind it; skipped $skipped."; return 0 ;;
  esac
  if [ "$status" != 200 ] || ! printf '%s\n' "$response" | sed '$d' | grep -q '"version":"[^"]*"'; then
    problem "ROOT_URL: got $(show "$root_url"); $instance/api/v1/version answered HTTP $status without a Gitea version; pass Gitea's ROOT_URL."
    return 0
  fi
  # Every Gitea page carries its ROOT_URL as window.config.appUrl.
  app_url=$(curl -s -m 10 -H 'Accept: text/html' "$instance/-/gitea-dev-install-check" 2>/dev/null |
    sed -n "s/.*appUrl: '\([^']*\)'.*/\1/p" | head -n 1 | sed 's#\\/#/#g') || app_url=''
  if [ -z "$app_url" ]; then
    note "Gitea at $instance showed no ROOT_URL (appUrl) on its pages; skipped comparing it with ROOT_URL."
  elif [ "${app_url%/}" != "$instance" ]; then
    problem "ROOT_URL: got $(show "$root_url"); Gitea at that address reports ROOT_URL $app_url; pass that URL."
  fi
  if [ "$workbench" = cdn ]; then
    preflight=$(curl -s -m 10 -o /dev/null -D - -X OPTIONS -H "Origin: $CDN_ORIGIN" -H 'Access-Control-Request-Method: GET' \
      -H 'Access-Control-Request-Headers: authorization' "$instance/api/v1/version" 2>/dev/null) || preflight=''
    origin=$(header_value "$preflight" access-control-allow-origin)
    if { [ "$origin" != "$CDN_ORIGIN" ] && [ "$origin" != '*' ]; } ||
      ! list_of "$(header_value "$preflight" access-control-allow-headers)" | grep -qx authorization; then
      cors_problem "ROOT_URL: Gitea at $instance refused a CORS preflight from $CDN_ORIGIN for its API with an Authorization header; --workbench=cdn needs [cors]."
    fi
    asset=$(curl -s -m 10 -o /dev/null -D - -H "Origin: $CDN_ORIGIN" "$instance/assets/img/logo.svg" 2>/dev/null) || asset=''
    origin=$(header_value "$asset" access-control-allow-origin)
    if [ "$origin" != "$CDN_ORIGIN" ] && [ "$origin" != '*' ]; then
      cors_problem "ROOT_URL: Gitea at $instance sends no Access-Control-Allow-Origin for $CDN_ORIGIN on static files; --workbench=cdn needs [cors] to load the extension."
    fi
  fi
  if [ -n "$checked_client_id" ]; then
    # Gitea checks the client, its type and the redirect URI before the (deliberately invalid) code.
    callback=$instance/assets/gitea-dev/oauth-callback.html
    body=$(curl -s -m 10 -X POST -H 'Content-Type: application/json' -H 'Accept: application/json' \
      --data "{\"grant_type\":\"authorization_code\",\"client_id\":\"$checked_client_id\",\"code\":\"gitea-dev-install-check\",\"redirect_uri\":\"$callback\"}" \
      "$instance/login/oauth/access_token" 2>/dev/null) || body=''
    case $body in
      *'cannot load client'*) problem "--oauth-client-id: got $(show "$checked_client_id"); Gitea has no OAuth application with this Client ID." ;;
      *'client secret'*) problem "--oauth-client-id: got $(show "$checked_client_id"); the application is confidential; register a public one (confidential_client false)." ;;
      *'unexpected redirect URI'*) problem "--oauth-client-id: got $(show "$checked_client_id"); the application lacks the redirect URI $callback; add it." ;;
      *'client is not authorized'*) ;;
      *) note "Gitea gave no recognizable answer about the OAuth application; skipped checking --oauth-client-id." ;;
    esac
  fi
}

custom='' root_url='' positional=0 extra=''
oauth_client_id='' has_client_id=0 webviews='' has_webviews=0 connect_src='' allowlist='' has_allowlist=0 gallery=$OPEN_VSX
workbench=cdn workbench_archive='' app_ini='' has_app_ini=0 test_mode=0
while [ $# -gt 0 ]; do
  arg=$1; shift
  case $arg in
    # For the test harness: writes the test hook flag and allows an http loopback ROOT_URL with cdn. Not in the usage text.
    --test-mode) test_mode=1; continue ;;
    --*=*) name=${arg%%=*}; value=${arg#*=} ;;
    --*)
      name=$arg
      if [ $# -eq 0 ]; then problem "$arg: needs a value; write $arg=VALUE."; continue; fi
      value=$1; shift ;;
    *)
      positional=$((positional + 1))
      case $positional in 1) custom=$arg ;; 2) root_url=$arg ;; 3) extra=$arg ;; esac
      continue ;;
  esac
  case $name in
    --oauth-client-id) oauth_client_id=$value; has_client_id=1 ;;
    --webviews) webviews=$value; has_webviews=1 ;;
    --connect-src) connect_src=$value ;;
    --extensions-allowlist) allowlist=$value; has_allowlist=1 ;;
    --gallery) gallery=$value ;;
    --workbench) workbench=$value ;;
    --workbench-archive) workbench_archive=$value ;;
    --app-ini) app_ini=$value; has_app_ini=1 ;;
    *) problem "$name: unknown option; expected one of --oauth-client-id, --webviews, --connect-src, --extensions-allowlist, --gallery, --workbench, --workbench-archive, --app-ini." ;;
  esac
done
[ "$positional" -le 2 ] || problem "$(show "$extra"): unexpected argument; expected only GITEA_CUSTOM and ROOT_URL before or between options."
[ -z "$problems" ] || usage_needed=1

# The release: its version and workbench pin (scripts/build.mjs writes workbench.json one field per line).
version=''
if [ -f "$here/VERSION" ]; then
  version=$(cat "$here/VERSION")
  matches "$version" "$VERSION_RE" || problem "VERSION: got $(show "$version"); expected <12 hex>-<12 hex> as the build writes it."
else
  problem "VERSION: missing from the release $here; rebuild or extract the release again."
fi
pin_ok=0
if [ -f "$here/workbench.json" ]; then
  pin_field() { sed -n "s/^  \"$1\": \"\([^\"]*\)\",\{0,1\}\$/\1/p" "$here/workbench.json" | head -n 1; }
  pin_commit=$(pin_field commit) pin_sha256=$(pin_field sha256) pin_url=$(pin_field url)
  pin_ok=1
  matches "$pin_commit" "$COMMIT_RE" || { pin_ok=0; problem "workbench.json commit: got $(show "$pin_commit"); expected 40 lowercase hex digits."; }
  matches "$pin_sha256" "$SHA256_RE" || { pin_ok=0; problem "workbench.json sha256: got $(show "$pin_sha256"); expected 64 lowercase hex digits."; }
  valid_url "$pin_url" || { pin_ok=0; problem "workbench.json url: got $(show "$pin_url"); expected an https URL."; }
else
  problem "workbench.json: missing from the release $here; rebuild or extract the release again."
fi

if [ "$positional" -lt 2 ]; then
  problem 'GITEA_CUSTOM and ROOT_URL: both are required, in this order.'
  usage_needed=1
fi
instance=''
if [ "$positional" -ge 2 ]; then
  if valid_url "$root_url"; then instance=${root_url%/}
  else problem "ROOT_URL: got $(show "$root_url"); expected $url_expected, equal to Gitea's [server] ROOT_URL."
  fi
fi
client_json=null checked_client_id=''
if [ "$has_client_id" = 1 ]; then
  if matches "$oauth_client_id" "$CLIENT_ID_RE"; then client_json="\"$oauth_client_id\"" checked_client_id=$oauth_client_id
  else problem "--oauth-client-id: got $(show "$oauth_client_id"); expected the Client ID of a Gitea OAuth application (1-128 letters, digits or hyphens)."
  fi
fi
valid_mode=1
case $workbench in cdn | download | local) ;; *) valid_mode=0; problem "--workbench: got $(show "$workbench"); expected cdn, download or local." ;; esac
# The page already loads from Microsoft's CDN in cdn mode, so webviews use its webview host by default.
if [ "$has_webviews" = 0 ]; then
  webviews=disabled
  [ "$workbench" != cdn ] || webviews=vscode-cdn
fi
[ "$webviews" = disabled ] || [ "$webviews" = vscode-cdn ] || problem "--webviews: got $(show "$webviews"); expected disabled or vscode-cdn."
if [ "$workbench" = local ] && [ -z "$workbench_archive" ]; then
  problem '--workbench=local: needs --workbench-archive=PATH, the pinned workbench archive.'
fi
if [ "$valid_mode" = 1 ] && [ "$workbench" != local ] && [ -n "$workbench_archive" ]; then
  problem "--workbench-archive: got $(show "$workbench_archive"); applies only to --workbench=local; remove it or add --workbench=local."
fi
set -f
connect_joined='' connect_sources=''
case $connect_src in
  *';'* | *','*) problem "--connect-src: got $(show "$connect_src"); expected sources separated by spaces, without \";\" or \",\"." ;;
  *)
    for source in $connect_src; do
      if matches "$source" "$SOURCE_RE"; then
        connect_joined="${connect_joined:+$connect_joined }$source"
        connect_sources="$connect_sources $source"
      else
        problem "--connect-src: source $(show "$source") not allowed; expected https://host or wss://host (a leading *. needs two more labels) or loopback http:// or ws://; no *, bare schemes, keywords, data: or blob:."
      fi
    done ;;
esac
allow_json=null
if [ "$has_allowlist" = 1 ]; then
  ids='' allow_json=''
  for id in $(printf '%s' "$allowlist" | tr '[:upper:]' '[:lower:]' | tr ',' ' '); do
    case " $ids " in *" $id "*) ;; *) ids="${ids:+$ids }$id" ;; esac
  done
  [ -n "$ids" ] || problem '--extensions-allowlist: got no ids; expected publisher.name ids, or --gallery=off to disable the gallery.'
  for id in $ids; do
    matches "$id" "$ID_RE" || problem "--extensions-allowlist: id $(show "$id") not valid; expected publisher.name in lowercase letters, digits and hyphens."
    allow_json="${allow_json:+$allow_json,}\"$id\""
  done
  allow_json="[$allow_json]"
fi
set +f
if [ "$workbench" = cdn ] && [ -n "$connect_joined" ]; then
  problem "--connect-src: got $(show "$connect_src"); applies only to --workbench=download or local, because in cdn mode Microsoft's extension host page allows any https: host; remove it."
fi
gallery_json=null gallery_sources=''
if [ "$gallery" != off ]; then
  if valid_url "$gallery"; then
    gallery=${gallery%/}
    gallery_json="\"$gallery\""
    origin=$(printf '%s\n' "$gallery" | sed 's#^\([a-z]*://[^/]*\).*$#\1#')
    gallery_sources=" $origin"
    [ "$origin" != "$OPEN_VSX" ] || gallery_sources="$gallery_sources $OPEN_VSX_CONTENT"
  else
    problem "--gallery: got $(show "$gallery"); expected off, or $url_expected."
  fi
fi
case $workbench:$instance:$test_mode in
  cdn:http:*:0) problem "ROOT_URL: got $(show "$root_url"); --workbench=cdn needs https, because WebKit blocks an http Gitea from the CDN extension host; serve Gitea over HTTPS or use --workbench=download." ;;
esac

if [ "$positional" -ge 1 ]; then
  if [ -z "$custom" ] || [ ! -e "$custom" ]; then
    problem "GITEA_CUSTOM: got $(show "$custom"); no such directory; pass Gitea's custom directory (CustomPath in \"gitea help\")."
  elif [ ! -d "$custom" ]; then
    problem "GITEA_CUSTOM: got $(show "$custom"); not a directory; pass Gitea's custom directory (CustomPath in \"gitea help\")."
  else
    [ -w "$custom" ] || problem "GITEA_CUSTOM: got $(show "$custom"); not writable; run the installer as the user that owns it."
    if [ -n "$(ls -A "$custom")" ] && [ ! -e "$custom/conf" ] && [ ! -e "$custom/public" ] && [ ! -e "$custom/templates" ] && [ ! -e "$custom/options" ]; then
      problem "GITEA_CUSTOM: got $(show "$custom"); does not look like Gitea's custom directory (expected it empty or holding conf, public, templates or options)."
    fi
  fi
fi
ini_path=''
if [ "$has_app_ini" = 1 ]; then
  if [ -n "$app_ini" ] && [ -f "$app_ini" ] && [ -r "$app_ini" ]; then
    case $app_ini in /*) ini_path=$app_ini ;; *) ini_path=$(cd "$(dirname "$app_ini")" && pwd)/$(basename "$app_ini") ;; esac
  else
    problem "--app-ini: got $(show "$app_ini"); not a readable file; pass the app.ini Gitea runs with (ConfigFile in \"gitea help\")."
  fi
elif [ "$positional" -ge 1 ] && [ -n "$custom" ] && [ -f "$custom/conf/app.ini" ]; then
  # Gitea's default configuration file is <custom path>/conf/app.ini (modules/setting/path.go).
  ini_path=$(cd "$custom" && pwd)/conf/app.ini
elif [ "$positional" -ge 1 ]; then
  note 'GITEA_CUSTOM has no conf/app.ini; skipped the app.ini checks (pass --app-ini=PATH when Gitea reads its configuration elsewhere).'
fi
[ -z "$ini_path" ] || check_app_ini "$ini_path"
if [ "$workbench" = local ] && [ -n "$workbench_archive" ]; then
  archive_path=$workbench_archive
  case $archive_path in /*) ;; *) archive_path=$(pwd)/$archive_path ;; esac
  if [ ! -f "$archive_path" ] || [ ! -r "$archive_path" ]; then
    problem "--workbench-archive: got $(show "$workbench_archive"); not a readable file; pass the archive from the url in the release's workbench.json."
  elif [ "$pin_ok" = 1 ] && [ "$(sha256_hex "$archive_path")" != "$pin_sha256" ]; then
    problem "--workbench-archive: got $(show "$workbench_archive"); its sha256 differs from the pinned $pin_sha256; pass the archive from the url in the release's workbench.json."
  fi
  workbench_archive=$archive_path
fi
[ -z "$instance" ] || check_gitea

problems="$problems$cors_problems"
if [ -n "$problems" ]; then
  printf '%s' "$notes$problems" >&2
  if [ -n "$cors_problems" ]; then
    if [ -n "$ini_path" ]; then printf '%s\n' "Add to Gitea's app.ini ($ini_path) and restart Gitea:" >&2
    else printf '%s\n' "Add to Gitea's app.ini and restart Gitea:" >&2
    fi
    printf '%s\n' "$cors_lines" >&2
  fi
  [ "$usage_needed" = 0 ] || printf '%s\n' "$usage" >&2
  exit 1
fi
printf '%s' "$notes" >&2

workbench_sources='' frame_sources='' workbench_json=null
if [ "$workbench" = cdn ]; then
  workbench_sources=" $CDN"
  workbench_json="\"$CDN/stable/$pin_commit/\""
fi
[ "$webviews" != vscode-cdn ] && [ "$workbench" != cdn ] || frame_sources=" $CDN_FRAMES"
test_json=false
[ "$test_mode" = 0 ] || test_json=true
config="{\"instance\":\"$instance\",\"version\":\"$version\",\"oauthClientId\":$client_json,\"gallery\":$gallery_json,\"extensionsAllowlist\":$allow_json,\"connectSrc\":\"$connect_joined\",\"webviews\":\"$webviews\",\"workbench\":$workbench_json,\"testMode\":$test_json}"
script_hashes_json='{}'

# Validated values and the pinned workbench's hashes contain no "|", "&" or "\", so they are literal
# in the sed replacement.
substitute() {
  sed -e "s|@WORKBENCH_SOURCES@|$workbench_sources|g" -e "s|@GALLERY_SOURCES@|$gallery_sources|g" \
    -e "s|@CONNECT_SOURCES@|$connect_sources|g" -e "s|@FRAME_SOURCES@|$frame_sources|g" \
    -e "s|\"@CONFIG@\"|$config|g" -e "s|\"@SCRIPT_HASHES@\"|$script_hashes_json|g" "$1" > "$1.sub"
  mv "$1.sub" "$1"
}

target=$(cd "$custom" && pwd)
source_root=$here/custom
# Existing templates and shortcut.js may hold operator changes; refuse to overwrite them before touching anything.
templates=$(cd "$source_root" && { find . -path "./$ASSETS" -prune -o -type f -print | sed 's#^\./##'; [ ! -f "$ASSETS/shortcut.js" ] || printf '%s\n' "$ASSETS/shortcut.js"; } | sort)
copies=''
old_ifs=$IFS
IFS='
'
for path in $templates; do
  if [ -e "$target/$path" ]; then
    cmp -s "$source_root/$path" "$target/$path" || die "Existing custom file differs; merge it before retrying: $target/$path"
  else
    copies="$copies$path
"
  fi
done
IFS=$old_ifs

# Stage everything, swap the version directory in, publish the top-level files, then the templates last.
release=$source_root/$ASSETS
assets=$target/$ASSETS
partial=$assets/.$version.partial
aside=$assets/.$version.old
scratch=$assets/.$version.workbench
rm -rf "$partial" "$scratch"
mkdir -p "$assets"
archive=$workbench_archive
if [ "$workbench" != cdn ]; then
  trap 'rm -rf "$scratch"' EXIT
  mkdir "$scratch"
fi
if [ "$workbench" = download ]; then
  archive=$scratch/workbench.tar.gz
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$archive" "$pin_url"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$archive" "$pin_url"
  else die 'Needs curl or wget to download the workbench'
  fi || die "Workbench download failed from $pin_url"
  [ "$(sha256_hex "$archive")" = "$pin_sha256" ] || die "The workbench downloaded from $pin_url does not match the pinned sha256 $pin_sha256."
fi
cp -R "$release/$version" "$partial"
if [ "$workbench" != cdn ]; then
  mkdir "$scratch/unpacked"
  (cd "$scratch/unpacked" && gzip -dc "$archive" | tar -xf -)
  set -- "$scratch/unpacked"/* "$scratch/unpacked"/.[!.]*
  [ -d "$1" ] && [ ! -e "$2" ] || die 'The workbench archive must hold one top-level directory'
  # Not served: Node-only workbench parts at any depth.
  find "$1" \( -name node -o -name bin -o -name node_modules.asar \) -prune -exec rm -rf {} +
  mv "$1" "$partial/workbench"
  iframe=$partial/$IFRAME
  [ -f "$iframe" ] || die "The workbench archive has no $IFRAME"
  # Upstream allows every https: host; extensions get the gallery and the operator allowlist only.
  [ "$(awk '{ n += gsub(/connect-src /, "") } END { print n + 0 }' "$iframe")" = 1 ] &&
    grep -q 'connect-src [^;"]*;' "$iframe" || die "Unexpected CSP in $IFRAME"
  sed "s/connect-src [^;\"]*;/connect-src 'self'@GALLERY_SOURCES@@CONNECT_SOURCES@;/g" "$iframe" > "$iframe.sub"
  mv "$iframe.sub" "$iframe"
  substitute "$iframe"
  script_hashes_json=''
  pages=$(cd "$partial" && find workbench -type f -name '*.html' | sort)
  IFS='
'
  for page in $pages; do
    hashes=$(script_hashes "$partial/$page")
    [ -z "$hashes" ] || script_hashes_json="${script_hashes_json:+$script_hashes_json,}\"$page\":\"$hashes\""
  done
  IFS=$old_ifs
  script_hashes_json="{$script_hashes_json}"
  rm -rf "$scratch"
fi
top=''
for file in "$release"/*; do
  [ -f "$file" ] || continue
  name=$(basename "$file")
  [ "$name" != shortcut.js ] || continue
  cp "$file" "$assets/$name.tmp"
  top="$top $name"
done
for name in index.html oauth-callback.html coi-sw.js; do substitute "$assets/$name.tmp"; done
printf '%s\n' "$config" > "$assets/configuration.json.tmp"
rm -rf "$aside"
if [ -e "$assets/$version" ]; then mv "$assets/$version" "$aside"; fi
mv "$partial" "$assets/$version"
rm -rf "$aside"
for name in configuration.json $top; do mv "$assets/$name.tmp" "$assets/$name"; done
IFS='
'
for path in $copies; do
  mkdir -p "$(dirname "$target/$path")"
  cp "$source_root/$path" "$target/$path.tmp"
  mv "$target/$path.tmp" "$target/$path"
done
IFS=$old_ifs
printf 'Installed Gitea Web IDE %s into %s. Restart Gitea if templates changed.\n' "$version" "$target"
