# Member photo copy: --photos copies every object of the source
# bucket into the target bucket under the same name; --validate-photos verifies names, bytes and
# that every fitfine.members photo path finds its object. One-time job: no retries, a failure is
# logged and the run moves on (PD6); running --photos again copies only what is still missing.
# The source is read through GET only (PD5). Keys reach curl through header files, never argv (PD8).

MIG_PHOTO_FAILS=0

photo_fail() { fail_line "$@"; MIG_PHOTO_FAILS=$((MIG_PHOTO_FAILS + 1)); }

# Project ref from https://<ref>.supabase.co
api_url_ref() {
  local re='^https://([a-z0-9]+)\.supabase\.co/?$'
  [[ $1 =~ $re ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}

# Project ref from a direct database URL (db.<ref>.supabase.co).
db_url_ref() {
  local re='^db\.([a-z0-9]+)\.supabase\.co$'
  parse_db_url "$1" || return 1
  [[ $DBU_HOST =~ $re ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}

# Writes the request headers for SIDE's key to a file in the private temp dir. A secret key
# (sb_secret_...) goes in apikey only; a legacy service-role JWT also goes in Authorization.
write_key_headers() {
  local side=$1 key=$2 file=$MIG_TMP/$1.headers
  ( umask 077; printf 'apikey: %s\n' "$key" >"$file" )
  case $key in sb_*) ;; *) printf 'Authorization: Bearer %s\n' "$key" >>"$file" ;; esac
}

# storage_call SIDE METHOD PATH CURL_ARGS...: prints the HTTP status (000 when the request failed).
# The source accepts GET only, checked before any request is made.
storage_call() {
  local side=$1 method=$2 path=$3 base status
  shift 3
  if [ "$side" = source ]; then
    [ "$method" = GET ] || die "refusing $method on the source: the source is read with GET only"
    base=$SOURCE_SUPABASE_URL
  else
    base=$TARGET_SUPABASE_URL
  fi
  status=$(curl -sS --max-time 120 -X "$method" -H @"$MIG_TMP/$side.headers" -w '%{http_code}' "$@" "${base%/}/storage/v1/$path") || status=000
  printf '%s' "${status:-000}"
}

# Downloads object NAME from SIDE to FILE. Prints the HTTP status.
download_object() {
  storage_call "$1" GET "object/authenticated/$PHOTO_BUCKET/$2" -o "$3"
}

# "<size> <sha256>" of a local file.
file_digest() { printf '%s %s' "$(wc -c <"$1" | tr -d ' ')" "$(shasum -a 256 "$1" | cut -d' ' -f1)"; }

# Bucket settings and object list, read from each side's database.
bucket_settings_sql="select public, coalesce(file_size_limit::text, ''), coalesce(array_to_json(allowed_mime_types)::text, 'null')
from storage.buckets where id = :'bucket';"
objects_sql="select name, metadata->>'size', coalesce(metadata->>'mimetype', ''), coalesce(metadata->>'cacheControl', '')
from storage.objects where bucket_id = :'bucket' order by name;"

bucket_settings() {
  local fn=psql_source
  [ "$1" = source ] || fn=psql_target_ro
  $fn -v bucket="$PHOTO_BUCKET" -f - <<<"$bucket_settings_sql"
}
list_objects() {
  local fn=psql_source
  [ "$1" = source ] || fn=psql_target_ro
  $fn -v bucket="$PHOTO_BUCKET" -f - <<<"$objects_sql"
}

# Task P0 (photo-copy-plan.md), part 1, before any connection: variables, URL refs, tools.
preflight_photo_vars() {
  local side url db ref dbref tool key role
  require_vars SOURCE_DB_URL TARGET_DB_URL SOURCE_SUPABASE_URL TARGET_SUPABASE_URL SOURCE_SERVICE_ROLE_KEY TARGET_SERVICE_ROLE_KEY PHOTO_BUCKET
  for side in source target; do
    if [ $side = source ]; then url=$SOURCE_SUPABASE_URL db=$SOURCE_DB_URL; else url=$TARGET_SUPABASE_URL db=$TARGET_DB_URL; fi
    ref=$(api_url_ref "$url") || refuse "$side: Supabase URL '$url' is not https://<ref>.supabase.co"
    dbref=$(db_url_ref "$db") || refuse "$side: cannot read the project ref from $(redact_db_url "$db")"
    [ "$ref" = "$dbref" ] || refuse "$side: Supabase URL ref $ref differs from its database ref $dbref; the key would not belong to that database"
  done
  # A legacy JWT key names its role: the anon key gets past GET but fails on RLS (HTTP 400) later.
  for side in SOURCE TARGET; do
    eval "key=\$${side}_SERVICE_ROLE_KEY"
    case $key in
      sb_publishable_*) refuse "${side}_SERVICE_ROLE_KEY is a publishable key; use the secret key (sb_secret_...) or the service_role key" ;;
      eyJ*)
        role=$(python3 -I -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; print(json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4))).get("role", ""))' "$key" 2>/dev/null) || role=''
        [ "$role" = service_role ] || refuse "${side}_SERVICE_ROLE_KEY is a JWT with role '${role:-unreadable}', not service_role (the anon key?); copy the service_role key" ;;
    esac
  done
  for tool in curl jq shasum; do
    command -v "$tool" >/dev/null 2>&1 || refuse "$tool not found on PATH"
  done
}

# Task P0, part 2, read-only: the keys work, the source bucket exists, a target bucket matches.
preflight_photos() {
  local status src tgt
  write_key_headers source "$SOURCE_SERVICE_ROLE_KEY"
  write_key_headers target "$TARGET_SERVICE_ROLE_KEY"
  status=$(storage_call source GET "bucket/$PHOTO_BUCKET" -o /dev/null)
  [ "$status" = 200 ] || refuse "source: GET bucket/$PHOTO_BUCKET returned HTTP $status (wrong key, URL or bucket?)"
  status=$(storage_call target GET bucket -o /dev/null)
  [ "$status" = 200 ] || refuse "target: GET bucket returned HTTP $status (wrong key or URL?)"

  src=$(bucket_settings source) || die "could not read the source bucket settings"
  [ -n "$src" ] || refuse "source bucket $PHOTO_BUCKET not found in storage.buckets"
  tgt=$(bucket_settings target) || die "could not read the target bucket settings"
  [ -z "$tgt" ] || [ "$tgt" = "$src" ] ||
    refuse "target bucket $PHOTO_BUCKET exists with different settings: source $(printf '%s' "$src" | tr "$US" ' '), target $(printf '%s' "$tgt" | tr "$US" ' ')"
  MIG_BUCKET_SETTINGS=$src
  log "photos  bucket $PHOTO_BUCKET: source ok, target $([ -n "$tgt" ] && echo 'exists with the same settings' || echo 'to be created')"
}

# Task P1: create the target bucket with the source's settings when it does not exist yet.
create_bucket_if_missing() {
  local public limit types body status
  [ -z "$(bucket_settings target)" ] || return 0
  IFS="$US" read -r public limit types <<<"$MIG_BUCKET_SETTINGS"
  body=$(jq -n --arg id "$PHOTO_BUCKET" --argjson public "$([ "$public" = t ] && echo true || echo false)" \
    --argjson limit "${limit:-null}" --argjson types "$types" \
    '{id: $id, name: $id, public: $public, file_size_limit: $limit, allowed_mime_types: $types}')
  status=$(storage_call target POST bucket -H 'Content-Type: application/json' --data-binary "$body" -o "$MIG_TMP/bucket.out")
  # Storage's error body ({"statusCode","error","message"}) says why; it holds no key or row data.
  [ "$status" = 200 ] || die "could not create the target bucket $PHOTO_BUCKET: HTTP $status $(jq -r '.message // empty' "$MIG_TMP/bucket.out" 2>/dev/null)"
  [ "$(bucket_settings target)" = "$MIG_BUCKET_SETTINGS" ] || die "the created target bucket's settings differ from the source's"
  log "photos  created target bucket $PHOTO_BUCKET with the source's settings"
}

# Task P2: copy. For each source object: absent from the target -> copy; present and identical ->
# skip; present but different -> log a mismatch and leave it (C1).
step_photos() {
  local dir name size mime cache tsize status n=0 copied=0 skipped=0 total
  local -a extra
  log "photos  copy: source $PHOTO_BUCKET -> target $PHOTO_BUCKET (same names)"
  create_bucket_if_missing
  dir=$(mktemp -d "$MIG_TMP/photos.XXXXXX")
  list_objects source >"$dir/source.list" || die "could not list the source objects"
  list_objects target >"$dir/target.list" || die "could not list the target objects"
  total=$(grep -c . "$dir/source.list" || true)

  while IFS="$US" read -r name size mime cache; do
    [ -n "$name" ] || continue
    n=$((n + 1))
    tsize=$(awk -F"$US" -v k="$name" '$1 == k { print $2; exit }' "$dir/target.list")
    if [ -n "$tsize" ]; then
      if [ "$tsize" != "$size" ]; then
        photo_fail P2 "$name" "mismatch: already in the target with a different size (source $size, target $tsize); left as it is"
        continue
      fi
      status=$(download_object source "$name" "$dir/s.bin")
      [ "$status" = 200 ] || { photo_fail P2 "$name" "source download HTTP $status"; rm -f "$dir/s.bin"; continue; }
      status=$(download_object target "$name" "$dir/t.bin")
      [ "$status" = 200 ] || { photo_fail P2 "$name" "target download HTTP $status"; rm -f "$dir/s.bin" "$dir/t.bin"; continue; }
      if [ "$(file_digest "$dir/s.bin")" = "$(file_digest "$dir/t.bin")" ]; then
        skipped=$((skipped + 1))
      else
        photo_fail P2 "$name" "mismatch: already in the target with different bytes; left as it is"
      fi
      rm -f "$dir/s.bin" "$dir/t.bin"
      continue
    fi

    status=$(download_object source "$name" "$dir/s.bin")
    if [ "$status" != 200 ]; then photo_fail P2 "$name" "source download HTTP $status"; rm -f "$dir/s.bin"; continue; fi
    if [ "$(wc -c <"$dir/s.bin" | tr -d ' ')" != "$size" ]; then
      photo_fail P2 "$name" "downloaded size differs from the source metadata ($size)"; rm -f "$dir/s.bin"; continue
    fi
    extra=()
    [ -z "$cache" ] || extra=(-H "cache-control: $cache")
    status=$(storage_call target POST "object/$PHOTO_BUCKET/$name" -H "Content-Type: ${mime:-application/octet-stream}" \
      ${extra[@]+"${extra[@]}"} -H 'x-upsert: false' --data-binary @"$dir/s.bin" -o /dev/null)
    rm -f "$dir/s.bin"
    if [ "$status" = 200 ]; then copied=$((copied + 1)); else photo_fail P2 "$name" "target upload HTTP $status"; fi
    [ $((n % 25)) != 0 ] || log "photos  $n / $total"
  done <"$dir/source.list"
  rm -rf "$dir"

  log "photos  $total source object(s): $copied copied, $skipped already identical, $MIG_PHOTO_FAILS failed"
  [ "$MIG_PHOTO_FAILS" = 0 ] || { log "photos  run --photos again after fixing the failures; it copies only what is still missing"; return "$EXIT_FAIL"; }
  return "$EXIT_OK"
}

# Task P3: verify (read-only). P3.1 same names; P3.2 same bytes; P3.3 every fitfine.members photo
# path finds its object. Orphans (objects no member references) are listed, never a failure.
step_validate_photos() {
  local dir name n=0 sd td status missing refs orphans
  log "photos  verify: names (P3.1), bytes (P3.2), members' photo paths (P3.3)"
  dir=$(mktemp -d "$MIG_TMP/verify.XXXXXX")
  list_objects source | cut -d"$US" -f1 | sort >"$dir/source.names" || die "could not list the source objects"
  list_objects target | cut -d"$US" -f1 | sort >"$dir/target.names" || die "could not list the target objects"

  # P3.1
  while IFS= read -r name; do photo_fail P3.1 "$name" "only in the source"; done < <(comm -23 "$dir/source.names" "$dir/target.names")
  while IFS= read -r name; do photo_fail P3.1 "$name" "only in the target"; done < <(comm -13 "$dir/source.names" "$dir/target.names")
  [ "$MIG_PHOTO_FAILS" != 0 ] || ok_line P3.1 "$(grep -c . "$dir/source.names" || true) names, the same in both buckets"

  # P3.2
  local before=$MIG_PHOTO_FAILS
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    n=$((n + 1))
    status=$(download_object source "$name" "$dir/s.bin")
    [ "$status" = 200 ] || { photo_fail P3.2 "$name" "source download HTTP $status"; rm -f "$dir/s.bin"; continue; }
    status=$(download_object target "$name" "$dir/t.bin")
    [ "$status" = 200 ] || { photo_fail P3.2 "$name" "target download HTTP $status"; rm -f "$dir/s.bin" "$dir/t.bin"; continue; }
    sd=$(file_digest "$dir/s.bin") td=$(file_digest "$dir/t.bin")
    rm -f "$dir/s.bin" "$dir/t.bin"
    [ "$sd" = "$td" ] || photo_fail P3.2 "$name" "bytes differ (source size ${sd%% *}, target size ${td%% *})"
  done < <(comm -12 "$dir/source.names" "$dir/target.names")
  [ "$MIG_PHOTO_FAILS" != "$before" ] || ok_line P3.2 "$n object(s) identical (size and SHA-256)"

  # P3.3
  missing=$(psql_target_ro -v bucket="$PHOTO_BUCKET" -v schema="$TARGET_SCHEMA" -f - <<'SQL'
select r.p from (select photo_url p from :"schema".members union select photo_thumbnail_url from :"schema".members) r
where r.p is not null
  and not exists (select 1 from storage.objects o where o.bucket_id = :'bucket' and o.name = r.p)
order by 1;
SQL
) || die "could not read $TARGET_SCHEMA.members on the target"
  refs=$(psql_target_ro -v schema="$TARGET_SCHEMA" -f - <<'SQL'
select count(*) from (select photo_url p from :"schema".members union select photo_thumbnail_url from :"schema".members) r where r.p is not null;
SQL
) || die "could not read $TARGET_SCHEMA.members on the target"
  if [ -z "$missing" ]; then ok_line P3.3 "$refs member photo path(s), every one found in the target bucket"
  else while IFS= read -r name; do photo_fail P3.3 "$name" "referenced by $TARGET_SCHEMA.members, missing from the target bucket"; done <<<"$missing"; fi

  orphans=$(psql_target_ro -v bucket="$PHOTO_BUCKET" -v schema="$TARGET_SCHEMA" -f - <<'SQL'
select count(*) from storage.objects o where o.bucket_id = :'bucket'
  and not exists (select 1 from :"schema".members m where m.photo_url = o.name or m.photo_thumbnail_url = o.name);
SQL
) || orphans='?'
  log "photos  $orphans object(s) in the target bucket are referenced by no member (orphans, kept; cleaned up later)"
  rm -rf "$dir"

  if [ "$MIG_PHOTO_FAILS" = 0 ]; then log "photos  verify ok: every P3 check passed"; return "$EXIT_OK"; fi
  log "photos  verify FAILED: $MIG_PHOTO_FAILS problem(s)"
  return "$EXIT_FAIL"
}
