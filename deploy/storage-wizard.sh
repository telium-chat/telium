#!/usr/bin/env bash
# Guided storage defaults for first-time Telium homeserver installation.
# Source this file; it never changes files. Reruns must never invoke it.

storage_error() { printf 'error: %s\n' "$*" >&2; return 1; }

storage_free_gib() {
  local kib
  kib="$(LC_ALL=C df -Pk "$1" | awk 'NR==2 {print $4}')" || return 1
  [[ "$kib" =~ ^[0-9]+$ ]] && (( kib >= 3 * 1024 * 1024 )) ||
    { storage_error "need at least 3 GiB of free disk space at $1 to install safely"; return 1; }
  printf '%s\n' "$((kib / 1024 / 1024))"
}

# Honor a TELIUM_* environment override; prompt only on an interactive stdin.
# Stdout is the selected value, stderr is the prompt and diagnostics.
#   storage_ask VAR LABEL DEFAULT PATTERN HINT [HELP]
# HINT says what a valid answer looks like; HELP is shown above the question.
storage_ask() {
  local var="$1" label="$2" default="$3" pattern="$4" hint="$5" help="${6:-}" value=""
  if [[ -v "$var" ]]; then
    value="${!var}"
  elif [[ -t 0 ]]; then
    [[ -z "$help" ]] || printf '\n%s\n' "$help" >&2
    printf '%s [%s]: ' "$label" "$default" >&2
    IFS= read -r value || { storage_error "could not read your answer for '$label'"; return 1; }
  fi
  value="${value:-$default}"
  [[ "$value" =~ $pattern ]] ||
    { storage_error "'$value' is not a valid answer for '$label' (expected $hint)"; return 1; }
  printf '%s\n' "$value"
}

storage_size_mib() {
  case "$1" in
    0) printf '0\n' ;;
    *GiB) local n="${1%GiB}"; printf '%s\n' "$((n * 1024))" ;;
    *MiB) printf '%s\n' "${1%MiB}" ;;
    *) storage_error "'$1' is not a size (use something like 500MiB or 20GiB)"; return 1 ;;
  esac
}

storage_wizard() {
  local data_dir="$1" backup_dir="$2" registration="$3"
  local data_gib backup_gib media_gib reserve_gib backup_reserve_gib
  local expiry_default backup_media_default size_re size_hint
  data_gib="$(storage_free_gib "$data_dir")" || return 1
  backup_gib="$(storage_free_gib "$backup_dir")" || return 1

  reserve_gib="$((data_gib / 10))"
  ((reserve_gib >= 1)) || reserve_gib=1
  backup_reserve_gib="$((backup_gib / 10))"
  ((backup_reserve_gib >= 1)) || backup_reserve_gib=1
  media_gib="$((data_gib * 3 / 4))"
  if ((media_gib >= data_gib - reserve_gib - 1)); then
    media_gib="$((data_gib - reserve_gib - 1))"
  fi
  ((media_gib >= 1)) || { storage_error "not enough free disk space to set aside a safety margin"; return 1; }

  if [[ "$registration" == open ]]; then
    expiry_default=30
    backup_media_default=no
  else
    expiry_default=0
    backup_media_default=yes
  fi
  size_re='^(0|[1-9][0-9]{0,6}(MiB|GiB))$'
  size_hint='a size such as 500MiB or 20GiB, or 0'

  printf '\n== Storage settings\n' >&2
  printf '  Telium keeps uploaded files and backups on this machine'"'"'s disk.\n' >&2
  if [[ "$(stat -c %d "$data_dir" 2>/dev/null)" == "$(stat -c %d "$backup_dir" 2>/dev/null)" ]]; then
    printf '  Free disk space: %s GiB (uploads and backups share it).\n' "$data_gib" >&2
  else
    printf '  Free disk space: %s GiB for uploads, %s GiB for backups.\n' "$data_gib" "$backup_gib" >&2
  fi
  printf '  Press Enter at any question to accept the suggestion in [brackets].\n' >&2
  printf '  Sizes are written like 500MiB or 20GiB.\n' >&2

  storage_policy="$(storage_ask TELIUM_MEDIA_POLICY 'Upload policy (quota/enabled/disabled)' quota \
    '^(quota|enabled|disabled)$' 'quota, enabled or disabled' \
'  Can people upload files (images, documents, and so on)?
    quota     everyone gets a storage allowance (recommended)
    enabled   uploads are allowed with no per-person limit
    disabled  nobody can upload files')" || return 1
  storage_user_quota="$(storage_ask TELIUM_MEDIA_QUOTA 'Storage allowance per person' 1GiB \
    '^[1-9][0-9]{0,6}(MiB|GiB)$' 'a size such as 500MiB or 2GiB')" || return 1
  storage_file_max="$(storage_ask TELIUM_MEDIA_FILE_MAX 'Largest single file' 50MiB \
    '^[1-9][0-9]{0,6}(MiB|GiB)$' 'a size such as 50MiB or 1GiB')" || return 1
  storage_media_total="$(storage_ask TELIUM_MEDIA_TOTAL 'Most space all uploads together may use (0 = no limit)' "${media_gib}GiB" \
    "$size_re" "$size_hint" \
'  A cap on all uploaded files combined, so they cannot fill the disk.')" || return 1
  storage_media_free="$(storage_ask TELIUM_MEDIA_FREE_RESERVE 'Free disk space to always keep (0 = off)' "${reserve_gib}GiB" \
    "$size_re" "$size_hint" \
'  Uploads are refused whenever free disk space drops below this. It keeps the
  disk from filling up completely, which would also stop the database.')" || return 1

  storage_retention_days="$(storage_ask TELIUM_MEDIA_RETENTION_DAYS 'Delete uploaded files after how many days (0 = never)' "$expiry_default" \
    '^(0|[1-9][0-9]{0,3})$' 'a number of days, or 0' \
'  Old uploads can be deleted automatically. This happens even if the message
  that shared the file still exists; the message stays, but its file is gone.
  Profile pictures and custom emoji are not deleted.')" || return 1

  storage_backup_media="$(storage_ask TELIUM_BACKUP_MEDIA 'Include uploaded files in backups? (yes/no)' "$backup_media_default" \
    '^(yes|no)$' 'yes or no' \
'  Backups are copies of your server'"'"'s data. Including uploaded files makes
  every backup much bigger. If you say no, uploaded files cannot be restored
  after a disk failure (avatars, emoji and similar small images are still kept).')" || return 1
  storage_backup_interval="$(storage_ask TELIUM_BACKUP_INTERVAL 'How often to back up (for example 6h, 12h, 1d)' 6h \
    '^[1-9][0-9]{0,2}(h|d)$' 'a number of hours or days such as 6h or 1d')" || return 1
  storage_backup_keep="$(storage_ask TELIUM_BACKUP_KEEP 'How many backups to keep' 2 \
    '^[1-9][0-9]{0,2}$' 'a number, such as 8')" || return 1
  storage_backup_free="$(storage_ask TELIUM_BACKUP_FREE_RESERVE 'Skip backups if free disk space would drop below (0 = off)' "${backup_reserve_gib}GiB" \
    "$size_re" "$size_hint")" || return 1

  if [[ "$storage_policy" == quota ]] &&
      (( $(storage_size_mib "$storage_user_quota") < $(storage_size_mib "$storage_file_max") )); then
    storage_error "the per-person allowance ($storage_user_quota) is smaller than the largest file ($storage_file_max), so nobody could upload a file of that size; raise the allowance or lower the file limit"
    return 1
  fi
  if (( $(storage_size_mib "$storage_media_free") >= data_gib * 1024 )); then
    storage_error "the free space to keep ($storage_media_free) is more than the disk has free (${data_gib}GiB), so every upload would be refused"
    return 1
  fi
  if (( $(storage_size_mib "$storage_backup_free") >= backup_gib * 1024 )); then
    storage_error "the backup free-space floor ($storage_backup_free) is more than the disk has free (${backup_gib}GiB), so every backup would be skipped"
    return 1
  fi

  printf '\n' >&2
  if [[ "$storage_retention_days" != 0 ]]; then
    printf '  Note: uploaded files will be deleted after %s days, even if the messages\n' "$storage_retention_days" >&2
    printf '  that shared them still exist.\n' >&2
  fi
  if [[ "$storage_backup_media" == yes ]]; then
    storage_backup_media_mode=all
  else
    # Avatars, banners, guild icons, emoji and stickers are small; keep them.
    storage_backup_media_mode=profile_assets
    printf '  Note: backups do NOT include uploaded files. Avatars, banners, server icons,\n' >&2
    printf '  emoji and stickers are included. If the disk fails, uploaded files are lost\n' >&2
    printf '  unless you copy them somewhere else yourself.\n' >&2
  fi
  if [[ "$storage_media_total" == 0 || "$storage_policy" == enabled ]]; then
    printf '  Note: there is no limit on how much people can upload, so uploads could\n' >&2
    printf '  use up the disk (down to the free space you chose to keep).\n' >&2
  fi
  if [[ "$storage_media_total" != 0 ]] &&
      (( $(storage_size_mib "$storage_media_total") + $(storage_size_mib "$storage_media_free") >= data_gib * 1024 )); then
    printf '  Note: the upload cap plus the free space to keep adds up to more than the disk\n' >&2
    printf '  has free, leaving no room for the database and backups.\n' >&2
  fi

  printf '\n  Your choices:\n' >&2
  printf '    Uploads: %s; %s per person; %s per file; %s in total; keep %s free.\n' \
    "$storage_policy" "$storage_user_quota" "$storage_file_max" "$storage_media_total" "$storage_media_free" >&2
  if [[ "$storage_retention_days" == 0 ]]; then
    printf '    Uploaded files are kept until they are deleted.\n' >&2
  else
    printf '    Uploaded files are deleted after %s days.\n' "$storage_retention_days" >&2
  fi
  printf '    Backups: every %s, keeping the last %s; uploaded files %s; skipped below %s free.\n' \
    "$storage_backup_interval" "$storage_backup_keep" \
    "$([[ "$storage_backup_media" == yes ]] && echo included || echo "not included")" "$storage_backup_free" >&2
  printf '\n  Backups stay on this machine, so a dead disk would take them with it.\n' >&2
  printf '  Copy the backup key (%s/backup.key) somewhere safe and set up an\n' "$backup_dir" >&2
  printf '  off-machine backup before relying on them.\n' >&2
}
