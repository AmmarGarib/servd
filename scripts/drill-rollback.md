# Rollback Drill

Goal: prove that a known-bad deploy can be reverted in under five minutes without manual intervention or human reasoning under pressure. Run this against staging the first time, then quarterly against production.

## Pre-drill checklist

- [ ] You're on a non-trading day, or staging is empty of customer activity.
- [ ] You have shell access and can hit the AWS CLI.
- [ ] The staging API is healthy: `curl https://api.staging.servd.pk/health` returns `200`.
- [ ] You know the current good image tag: `aws ecs describe-services --cluster servd-staging-cluster --services servd-staging-api | jq -r '.services[0].taskDefinition'` → note the family + revision.

## Step 1 — record the known-good state

```bash
GOOD_TASK_DEF=$(aws ecs describe-services \
  --cluster servd-staging-cluster \
  --services servd-staging-api \
  --query 'services[0].taskDefinition' --output text)
echo "Good task def: $GOOD_TASK_DEF"
```

Save this output. You will need it to roll forward.

## Step 2 — deploy a deliberately broken image

In your terminal, build a tiny image that fails its health check and push it:

```bash
# In a scratch directory
cat > Dockerfile.broken <<'EOF'
FROM nginx:alpine
RUN echo 'server { listen 3001; location /health { return 503 "broken"; } }' \
  > /etc/nginx/conf.d/default.conf
EXPOSE 3001
EOF

ECR=$(aws ecr describe-repositories --repository-names servd-api \
  --query 'repositories[0].repositoryUri' --output text)

aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin "$ECR"

docker build -t "$ECR:broken-drill" -f Dockerfile.broken .
docker push "$ECR:broken-drill"
```

Now register a task definition that uses the broken image and force-deploy:

```bash
# Pull the current task def, swap the image, register the new one
aws ecs describe-task-definition --task-definition servd-staging-api \
  | jq --arg img "$ECR:broken-drill" '
      .taskDefinition
      | .containerDefinitions[0].image = $img
      | { family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, volumes, placementConstraints, requiresCompatibilities, cpu, memory }
    ' > broken-task-def.json

BROKEN_ARN=$(aws ecs register-task-definition --cli-input-json file://broken-task-def.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)

aws ecs update-service \
  --cluster servd-staging-cluster \
  --service servd-staging-api \
  --task-definition "$BROKEN_ARN" \
  --force-new-deployment >/dev/null

echo "Broken deploy started. Watch the service…"
```

## Step 3 — observe the failure

The new tasks will fail their health check (`/health` returns 503). ECS will keep them in the DRAINING state and the ALB won't route to them. Because the deploy config has `deployment_minimum_healthy_percent = 100`, the old tasks stay up — service should remain functional from the user's perspective.

Watch:

```bash
# In another shell
watch -n 5 'aws ecs describe-services \
  --cluster servd-staging-cluster \
  --services servd-staging-api \
  --query "services[0].deployments[].[status,desiredCount,runningCount,failedTasks]" \
  --output table'
```

The new deployment's `failedTasks` will increment. After a few minutes it'll be obvious that the broken image isn't going to come up.

**Pass criterion:** `https://api.staging.staging.servd.pk/health` continues returning `200` throughout. ECS isolates the failure to the new tasks; the old tasks keep serving traffic.

## Step 4 — roll back

```bash
aws ecs update-service \
  --cluster servd-staging-cluster \
  --service servd-staging-api \
  --task-definition "$GOOD_TASK_DEF" \
  --force-new-deployment >/dev/null

aws ecs wait services-stable \
  --cluster servd-staging-cluster \
  --services servd-staging-api
```

Time this. Note the wall-clock duration from "kicked the rollback" to "services stable."

## Step 5 — verify recovery

```bash
curl -s https://api.staging.servd.pk/health | jq .
# Must show: { "status": "ok", ... }

# And the running task def matches the good one
aws ecs describe-services \
  --cluster servd-staging-cluster \
  --services servd-staging-api \
  --query 'services[0].taskDefinition' --output text
# Should equal $GOOD_TASK_DEF
```

## Step 6 — clean up

```bash
aws ecr batch-delete-image \
  --repository-name servd-api \
  --image-ids imageTag=broken-drill
```

## Pass / fail criteria

- **Pass**: Service health stayed green throughout the broken deploy. Rollback completed in < 5 minutes wall-clock. Health check returns `200` after rollback.
- **Fail (any of)**:
  - `/health` returned `503` to the public during the drill.
  - Rolling back took > 5 minutes.
  - Old tasks were terminated before the new tasks were healthy (i.e. `deployment_minimum_healthy_percent` is misconfigured).
  - You couldn't easily find the previous task definition revision (process gap — fix tooling).

If anything failed, fix it BEFORE the drill becomes a real incident. The most common gap: nobody documented how to find the previous task def. The fix is to keep `GOOD_TASK_DEF` written somewhere durable after every prod deploy — the deploy.yml workflow should be modified to cut a tag-annotated commit on every successful production roll.

## Production caveats

When running this against production:

- **Coordinate first.** Tell the team a window. Don't drill during dinner service.
- **Use a separate broken-image tag** so you can never accidentally re-pull `:broken-drill` to prod by mistake — delete the tag immediately after.
- **Watch the Foodpanda webhook queue.** If orders are mid-flight, you don't want any drift. The `deployment_minimum_healthy_percent = 100` config should keep continuity, but verify after.
- **Have the on-call Slack channel pinned.** If something unexpected happens during the drill, you escalate immediately, don't try to debug.
