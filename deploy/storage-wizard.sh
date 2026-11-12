#!/usr/bin/env bash
# Guided storage defaults for first-time Telium homeserver installation.
# Source this file; it never changes files. Reruns must never invoke it.

storage_error() { printf 'error: %s\n' "$*" >&2; return 1; }

storage_free_gib() {
  local kib
  kib="$(LC_ALL=C df -Pk "$1" | awk 'NR==2 {print $4}')" || return 1
  [[ "$kib" =~ ^[0-9]+$ ]] && (( kib >= 3 * 1024 * 1024 )) ||
    { storage_error "need at least 3 GiB free at $1 to install safely"; return 1; }
  printf '%s\n' "$((kib / 1024 / 1024))"
}

# Honor a TELIUM_* environment override; prompt only on an interactive stdin.
# Stdout is the selected value, stderr is the prompt and diagnostics.
storage_ask() {
  local var="$1" label="$2" default="$3" pattern="$4" value=""
  if [[ -v "$var" ]]; then
    value="${!var}"
  elif [[ -t 0 ]]; then
    printf '%s [%s]: ' "$label" "$default" >&2
    IFS= read -r value || { storage_error "cannot read $label"; return 1; }
  fi
  value="${value:-$default}"
  [[ "$value" =~ $pattern ]] ||
    { storage_error "invalid $label: '$value'"; return 1; }
  printf '%s\n' "$value"
}

storage_size_mib() {
  case "$1" in
    0) printf '0\n' ;;
    *GiB) local n="${1%GiB}"; printf '%s\n' "$((n * 1024))" ;;
    *MiB) printf '%s\n' "${1%MiB}" ;;
    *) storage_error "invalid size $1"; return 1 ;;
  esac
}

storage_wizard() {
  local data_dir="$1" backup_dir="$2" registration="$3"
  local data_gib backup_gib media_gib reserve_gib backup_reserve_gib
  local expiry_default backup_media_default size_re
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
  ((media_gib >= 1)) || { storage_error "not enough space to reserve capacity"; return 1; }

  if [[ "$registration" == open ]]; then
    expiry_default=30
    backup_media_default=no
  else
    expiry_default=0
    backup_media_default=yes
  fi
  size_re='^(0|[1-9][0-9]{0,6}(MiB|GiB))$'

  printf '\n== Storage configuration\n' >&2
  printf '  Found %s GiB available for media; %s GiB for backup archives.\n' "$data_gib" "$backup_gib" >&2
  printf '  Press Enter for the recommended value. Enter sizes as MiB or GiB.\n' >&2
  storage_policy="$(storage_ask TELIUM_MEDIA_POLICY 'Account upload policy (quota/enabled/disabled)' quota '^(quota|enabled|disabled)$')" || return 1
  storage_user_quota="$(storage_ask TELIUM_MEDIA_QUOTA 'Per-user media allowance' 1GiB '^[1-9][0-9]{0,6}(MiB|GiB)$')" || return 1
  storage_file_max="$(storage_ask TELIUM_MEDIA_FILE_MAX 'Maximum file size' 50MiB '^[1-9][0-9]{0,6}(MiB|GiB)$')" || return 1
  storage_media_total="$(storage_ask TELIUM_MEDIA_TOTAL 'Total hosted media limit (0 = unlimited)' "${media_gib}GiB" "$size_re")" || return 1
  storage_media_free="$(storage_ask TELIUM_MEDIA_FREE_RESERVE 'Reserved free space for media (0 = disabled)' "${reserve_gib}GiB" "$size_re")" || return 1

  printf '  Retention deletes attachments EVEN WHEN STILL REFERENCED by messages.\n' >&2
  storage_retention_days="$(storage_ask TELIUM_MEDIA_RETENTION_DAYS 'Delete uploads after N days (0 = no forced expiry)' "$expiry_default" '^(0|[1-9][0-9]{0,3})$')" || return 1

  printf '  Media backups make multiple copies of the same files; excluding them\n' >&2
  printf '  means those attachments cannot be restored after a disk failure.\n' >&2
  storage_backup_media="$(storage_ask TELIUM_BACKUP_MEDIA 'Include media in backups? (yes/no)' "$backup_media_default" '^(yes|no)$')" || return 1
  storage_backup_interval="$(storage_ask TELIUM_BACKUP_INTERVAL 'Backup frequency (6h, 12h, 1d)' 6h '^[1-9][0-9]{0,2}(h|d)$')" || return 1
  storage_backup_keep="$(storage_ask TELIUM_BACKUP_KEEP 'Local backups to retain' 8 '^[1-9][0-9]{0,2}$')" || return 1
  storage_backup_free="$(storage_ask TELIUM_BACKUP_FREE_RESERVE 'Reserved free space for backups (0 = disabled)' "${backup_reserve_gib}GiB" "$size_re")" || return 1

  if [[ "$storage_policy" == quota ]] &&
      (( $(storage_size_mib "$storage_user_quota") < $(storage_size_mib "$storage_file_max") )); then
    storage_error "per-user quota cannot be smaller than the largest file"
    return 1
  fi
  if (( $(storage_size_mib "$storage_media_free") >= data_gib * 1024 )); then
    storage_error "media free-space reserve cannot exceed current free disk space"
    return 1
  fi
  if (( $(storage_size_mib "$storage_backup_free") >= backup_gib * 1024 )); then
    storage_error "backup free-space reserve cannot exceed current free disk space"
    return 1
  fi
  if [[ "$storage_retention_days" == 0 ]]; then
    storage_expiry="0"
  else
    storage_expiry="${storage_retention_days}d"
    printf '  WARNING: Files will expire after %s days, including files in live messages.\n' "$storage_retention_days" >&2
  fi
  if [[ "$storage_backup_media" == yes ]]; then
    storage_include_media=true
  else
    storage_include_media=false
    printf '  WARNING: Backups EXCLUDE uploaded files, avatars and custom emoji.\n' >&2
    printf '  A disk failure will permanently lose media without a separate media backup.\n' >&2
  fi
  if [[ "$storage_media_total" == 0 || "$storage_policy" == enabled ]]; then
    printf '  WARNING: One or more upload budgets are unlimited.\n' >&2
  fi
  if [[ "$storage_media_total" != 0 ]] &&
      (( $(storage_size_mib "$storage_media_total") + $(storage_size_mib "$storage_media_free") >= data_gib * 1024 )); then
    printf '  WARNING: Media budget plus reserve leaves no room for other files.\n' >&2
  fi
  printf '  Selected: %s; quota %s/user; %s/file; media cap %s; free reserve %s;\n' \
    "$storage_policy" "$storage_user_quota" "$storage_file_max" "$storage_media_total" "$storage_media_free" >&2
  printf '  retention %s days; backup media %s; backup every %s, keep %s; reserve %s.\n' \
    "$storage_retention_days" "$storage_backup_media" "$storage_backup_interval" "$storage_backup_keep" "$storage_backup_free" >&2
  printf '  Offsite backups are separate: save the backup encryption key and arrange\n' >&2
  printf '  an external recovery destination before relying on local archives.\n' >&2
}
