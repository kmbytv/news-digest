#!/usr/bin/env bash
# deploy.sh — загружает все воркфлоу в n8n, активирует их и (опционально)
# регистрирует Telegram-webhook для обработки лайков.
#
# Деплоит:
#   workflow.json           → 🌅 Morning News Digest    (сбор + дайджест)
#   workflow_feedback.json  → 📬 Digest Feedback Handler (приём лайков + /stats)
#   workflow_weekly.json    → 📅 Weekly Digest          (итоги недели, воскресенье)
#
# Требует:
#   N8N_URL        — адрес n8n (задан в Railway)
#   N8N_API_KEY    — API-ключ n8n (Settings → n8n API → Create)
# Опционально:
#   TELEGRAM_TOKEN — если задан, скрипт сам зарегистрирует webhook в Telegram
#   jq             — для надёжного парсинга (иначе используется python3)
#
# Запуск:
#   N8N_API_KEY=your_key bash deploy.sh

set -euo pipefail

# ── проверки ──────────────────────────────────────────────────────────────────
: "${N8N_URL:?Переменная N8N_URL не задана}"
: "${N8N_API_KEY:?Переменная N8N_API_KEY не задана — создай ключ в Settings → n8n API}"

command -v curl &>/dev/null || { echo "❌ curl не установлен" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── JSON-хелперы (jq → python3 → grep) ─────────────────────────────────────────

# json_get FIELD  — читает JSON из stdin, печатает значение верхнеуровневого поля
json_get() {
  local field="$1"
  if command -v jq &>/dev/null; then
    jq -r ".${field} // empty"
  elif command -v python3 &>/dev/null; then
    python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('${field}','') if isinstance(d,dict) else '')"
  else
    grep -oP "\"${field}\"\s*:\s*\"?\K[^\",}]+" | head -1
  fi
}

# find_id_by_name NAME  — читает список воркфлоу из stdin, печатает id с этим именем
find_id_by_name() {
  local name="$1"
  if command -v jq &>/dev/null; then
    jq -r --arg n "$name" '.data[] | select(.name==$n) | .id' | head -1
  elif command -v python3 &>/dev/null; then
    python3 -c "import json,sys;n=sys.argv[1];d=json.load(sys.stdin);print(next((w['id'] for w in d.get('data',[]) if w.get('name')==n),''))" "$name"
  else
    echo ""  # без JSON-инструмента сопоставить по имени нельзя
  fi
}

# ── деплой одного воркфлоу: создать или обновить (по имени) + активировать ──────
LAST_WF_ID=""   # сюда функция кладёт id задеплоенного воркфлоу

deploy_workflow() {
  local file="$1"
  [[ -f "$file" ]] || { echo "❌ Не найден файл: $file" >&2; return 1; }

  local name; name="$(json_get name < "$file")"
  echo "── ${name}  (${file##*/})"

  local resp http body
  resp=$(curl -s -X POST "${N8N_URL}/api/v1/workflows" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary @"${file}" \
    --write-out $'\n%{http_code}')
  http=$(printf '%s' "$resp" | tail -n1)
  body=$(printf '%s' "$resp" | sed '$d')

  local wf_id
  if [[ "$http" == "409" ]] || printf '%s' "$body" | grep -qi 'already exists'; then
    echo "   🔄 уже существует — обновляю"
    local list
    list=$(curl -sf "${N8N_URL}/api/v1/workflows?limit=250" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}")
    wf_id=$(printf '%s' "$list" | find_id_by_name "$name")
    if [[ -z "$wf_id" ]]; then
      echo "   ❌ не нашёл '${name}' среди существующих. Удали вручную и перезапусти." >&2
      return 1
    fi
    curl -sf -X PUT "${N8N_URL}/api/v1/workflows/${wf_id}" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
      -H "Content-Type: application/json" \
      --data-binary @"${file}" >/dev/null
    echo "   ✅ обновлён (ID: ${wf_id})"
  else
    wf_id=$(printf '%s' "$body" | json_get id)
    if [[ -z "$wf_id" || "$wf_id" == "null" ]]; then
      echo "   ❌ не удалось создать. Ответ сервера:" >&2
      printf '%s\n' "$body" >&2
      return 1
    fi
    echo "   ✅ создан (ID: ${wf_id})"
  fi

  curl -sf -X POST "${N8N_URL}/api/v1/workflows/${wf_id}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" >/dev/null
  echo "   ⚡ активирован"

  LAST_WF_ID="$wf_id"
}

# ── поехали ─────────────────────────────────────────────────────────────────--
echo "🚀 Деплоим в ${N8N_URL}"
echo ""

deploy_workflow "${SCRIPT_DIR}/workflow.json"
MAIN_WF_ID="${LAST_WF_ID}"
echo ""

deploy_workflow "${SCRIPT_DIR}/workflow_feedback.json"
echo ""

deploy_workflow "${SCRIPT_DIR}/workflow_weekly.json"
echo ""

# ── регистрация Telegram-webhook ──────────────────────────────────────────────
WEBHOOK_URL="${N8N_URL}/webhook/feedback"
if [[ -n "${TELEGRAM_TOKEN:-}" ]]; then
  echo "🔗 Регистрирую Telegram-webhook → ${WEBHOOK_URL}"

  # передаём secret_token только если он задан
  # Telegram требует: 1-256 символов, только A-Z a-z 0-9 _ -
  if [[ -n "${TELEGRAM_WEBHOOK_SECRET:-}" ]]; then
    curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook" \
      -d "url=${WEBHOOK_URL}" \
      -d "allowed_updates=[\"callback_query\",\"message\"]" \
      -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" >/dev/null \
      && echo "   ✅ webhook зарегистрирован (с secret_token)" \
      || echo "   ⚠️ не удалось зарегистрировать webhook"
  else
    echo "   ⚠️ TELEGRAM_WEBHOOK_SECRET не задан — webhook будет без защиты"
    curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook" \
      -d "url=${WEBHOOK_URL}" \
      -d "allowed_updates=[\"callback_query\",\"message\"]" >/dev/null \
      && echo "   ✅ webhook зарегистрирован (без secret_token)" \
      || echo "   ⚠️ не удалось зарегистрировать webhook"
  fi
  echo ""
else
  echo "ℹ️  TELEGRAM_TOKEN не задан — зарегистрируй webhook вручную:"
  echo "   curl -X POST \"https://api.telegram.org/bot\${TELEGRAM_TOKEN}/setWebhook\" \\"
  echo "     -d 'url=${WEBHOOK_URL}' -d 'allowed_updates=[\"callback_query\",\"message\"]' \\"
  echo "     -d 'secret_token=\${TELEGRAM_WEBHOOK_SECRET}'"
  echo ""
fi

# ── итог ────────────────────────────────────────────────────────────────────--
echo "🎉 Готово! Дайджест приходит каждый день в 08:00 МСК, лайки учитываются."
echo ""
echo "Тестовый запуск дайджеста (немедленно):"
echo "  curl -s -X POST ${N8N_URL}/api/v1/workflows/${MAIN_WF_ID}/run \\"
echo "    -H 'X-N8N-API-KEY: \${N8N_API_KEY}' -H 'Content-Type: application/json' \\"
echo "    -d '{\"startNodes\":[]}'"
echo ""
echo "Логи последних запусков:"
echo "  curl -s '${N8N_URL}/api/v1/executions?workflowId=${MAIN_WF_ID}&limit=5' \\"
echo "    -H 'X-N8N-API-KEY: \${N8N_API_KEY}' | jq '.data[].status'"
