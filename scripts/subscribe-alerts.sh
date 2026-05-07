#!/usr/bin/env bash
#
# Subscribe an email and/or phone number to the servd CloudWatch alerts SNS
# topic. Without subscribers, the alarms in main.tf fire into the void.
#
# Usage:
#   EMAIL=ops@servd.pk SMS=+923001234567 ./subscribe-alerts.sh staging
#   EMAIL=ops@servd.pk                    ./subscribe-alerts.sh production
#
# After running, the email recipient must click the AWS confirmation link
# before they start receiving alerts. SMS subscriptions are confirmed
# automatically.

set -euo pipefail

ENV="${1:-staging}"
APP=$([[ "$ENV" = "production" ]] && echo "servd" || echo "servd-staging")
TOPIC_ARN=$(aws sns list-topics \
  --query "Topics[?contains(TopicArn, '${APP}-alerts')].TopicArn | [0]" \
  --output text)

if [ -z "$TOPIC_ARN" ] || [ "$TOPIC_ARN" = "None" ]; then
  echo "No SNS topic found for ${APP}-alerts. Has terraform apply run?" >&2
  exit 1
fi

echo "Topic: $TOPIC_ARN"

if [ -n "${EMAIL:-}" ]; then
  echo "→ subscribing email $EMAIL (will need to confirm via clicked link)"
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$EMAIL" >/dev/null
fi

if [ -n "${SMS:-}" ]; then
  echo "→ subscribing SMS $SMS"
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sms --notification-endpoint "$SMS" >/dev/null
fi

if [ -z "${EMAIL:-}" ] && [ -z "${SMS:-}" ]; then
  echo "Set EMAIL and/or SMS env vars. Nothing to do." >&2
  exit 1
fi

echo
echo "Done. Test by publishing:"
echo "  aws sns publish --topic-arn $TOPIC_ARN --subject 'Test alert' --message 'Confirming alerts work'"
