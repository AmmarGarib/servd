terraform {
  required_version = ">= 1.7"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Backend config is supplied via -backend-config so the same code can target
  # prod or staging without editing this file:
  #   prod:    terraform init -backend-config=prod.tfbackend
  #   staging: terraform init -backend-config=staging.tfbackend
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
  default_tags { tags = { App = var.app_name, ManagedBy = "terraform" } }
}

# ─── Variables ────────────────────────────────────────────────────────────────

variable "aws_region"         { default = "ap-south-1" }
variable "app_name"           { default = "servd" }
variable "domain"             { default = "servd.pk" }
variable "db_password"        { sensitive = true }
variable "redis_auth_token"   { sensitive = true }
variable "jwt_secret"         { sensitive = true }
variable "jwt_refresh_secret" { sensitive = true }
variable "keenu_webhook_secret"     { sensitive = true, default = "" }
variable "foodpanda_webhook_secret" { sensitive = true, default = "" }
variable "careem_webhook_secret"    { sensitive = true, default = "" }
variable "twilio_auth_token"  { sensitive = true, default = "" }
variable "ses_smtp_user"      { sensitive = true, default = "" }
variable "ses_smtp_password"  { sensitive = true, default = "" }

# Ops alert email — receives SNS paging for all CloudWatch alarms.
# Leave empty to skip email subscription (useful in staging).
variable "alert_email" { default = "" }

# FBR PRAL Electronic POS credentials (SRO 1307(I)/2022 compliance).
# Required for any concept registered with FBR as a Tier-1 business.
variable "fbr_username" { sensitive = true, default = "" }
variable "fbr_password" { sensitive = true, default = "" }

variable "api_image_tag"        { default = "latest" }
variable "web_image_tag"        { default = "latest" }
variable "storefront_image_tag" { default = "latest" }

variable "api_desired_count"        { default = 2, type = number }
variable "web_desired_count"        { default = 2, type = number }
variable "storefront_desired_count" { default = 2, type = number }

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  api_domain        = "api.${var.domain}"
  web_domain        = "ops.${var.domain}"
  storefront_domain = "order.${var.domain}"
}

# ─── VPC ──────────────────────────────────────────────────────────────────────
# Dual NAT (one per AZ): outbound from any container survives a NAT-AZ failure.
# A single NAT means a Twilio/Keenu/Foodpanda outage if that one AZ goes down.

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.5.2"

  name = "${var.app_name}-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["${var.aws_region}a", "${var.aws_region}b"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]

  enable_nat_gateway     = true
  single_nat_gateway     = false
  one_nat_gateway_per_az = true

  enable_dns_hostnames = true
  enable_dns_support   = true
}

# ─── Security Groups ──────────────────────────────────────────────────────────
# Least-privilege: each tier opens only what it needs to the tier above it.

resource "aws_security_group" "alb" {
  name        = "${var.app_name}-alb-sg"
  description = "Public ALB — HTTPS only from internet"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_security_group_rule" "alb_https_in" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "alb_http_in" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTP only to redirect to HTTPS"
}

resource "aws_security_group_rule" "alb_egress_to_app" {
  type                     = "egress"
  security_group_id        = aws_security_group.alb.id
  from_port                = 3000
  to_port                  = 3001
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
}

resource "aws_security_group" "app" {
  name        = "${var.app_name}-app-sg"
  description = "ECS Fargate tasks"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_security_group_rule" "app_in_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.app.id
  from_port                = 3000
  to_port                  = 3001
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group_rule" "app_egress_db" {
  type                     = "egress"
  security_group_id        = aws_security_group.app.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.db.id
}

resource "aws_security_group_rule" "app_egress_redis" {
  type                     = "egress"
  security_group_id        = aws_security_group.app.id
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.redis.id
}

resource "aws_security_group_rule" "app_egress_https" {
  type              = "egress"
  security_group_id = aws_security_group.app.id
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Outbound to Twilio/Keenu/Foodpanda/SES/SSM"
}

resource "aws_security_group_rule" "app_egress_smtp" {
  type              = "egress"
  security_group_id = aws_security_group.app.id
  from_port         = 587
  to_port           = 587
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Outbound SES SMTP submission"
}

resource "aws_security_group" "db" {
  name        = "${var.app_name}-db-sg"
  description = "RDS Postgres — access from app only"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_security_group_rule" "db_in_from_app" {
  type                     = "ingress"
  security_group_id        = aws_security_group.db.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
}

resource "aws_security_group" "redis" {
  name        = "${var.app_name}-redis-sg"
  description = "ElastiCache Redis — access from app only"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_security_group_rule" "redis_in_from_app" {
  type                     = "ingress"
  security_group_id        = aws_security_group.redis.id
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
}

# ─── KMS for RDS / Redis encryption at rest ──────────────────────────────────

resource "aws_kms_key" "data" {
  description             = "${var.app_name} data encryption (RDS, Redis, SSM)"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.app_name}-data"
  target_key_id = aws_kms_key.data.key_id
}

# ─── RDS PostgreSQL — encrypted, multi-AZ, PITR ──────────────────────────────

resource "aws_db_subnet_group" "main" {
  name       = "${var.app_name}-db-subnet"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_db_parameter_group" "postgres15" {
  name   = "${var.app_name}-pg15"
  family = "postgres15"

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
}

resource "aws_db_instance" "postgres" {
  identifier              = "${var.app_name}-postgres"
  engine                  = "postgres"
  engine_version          = "15.6"
  instance_class          = "db.t3.small"
  allocated_storage       = 20
  max_allocated_storage   = 200

  db_name                 = "servd"
  username                = "servd"
  password                = var.db_password
  parameter_group_name    = aws_db_parameter_group.postgres15.name

  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.db.id]

  storage_encrypted       = true
  kms_key_id              = aws_kms_key.data.arn
  multi_az                = true
  backup_retention_period = 14
  backup_window           = "21:00-22:00"  # 02:00-03:00 PKT, off-peak
  maintenance_window      = "Mon:22:00-Mon:23:00"
  performance_insights_enabled = true
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql"]

  copy_tags_to_snapshot     = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.app_name}-final-snapshot"
  deletion_protection       = true
}

# ─── ElastiCache Redis — encrypted in-transit + at-rest, auth ─────────────────

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.app_name}-redis-subnet"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id          = "${var.app_name}-redis"
  description                   = "${var.app_name} Redis"
  engine                        = "redis"
  engine_version                = "7.1"
  node_type                     = "cache.t3.small"
  num_cache_clusters            = 2
  automatic_failover_enabled    = true
  multi_az_enabled              = true
  parameter_group_name          = "default.redis7"
  port                          = 6379

  subnet_group_name             = aws_elasticache_subnet_group.main.name
  security_group_ids            = [aws_security_group.redis.id]

  at_rest_encryption_enabled    = true
  transit_encryption_enabled    = true
  kms_key_id                    = aws_kms_key.data.arn
  auth_token                    = var.redis_auth_token

  snapshot_retention_limit      = 7
  snapshot_window               = "20:00-21:00"
}

# ─── ECR ──────────────────────────────────────────────────────────────────────
# Immutable tags + scanning — no overwriting `:latest` after a release ships.

resource "aws_ecr_repository" "api" {
  name                 = "servd-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "KMS", kms_key = aws_kms_key.data.arn }
}

resource "aws_ecr_repository" "web" {
  name                 = "servd-web"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "KMS", kms_key = aws_kms_key.data.arn }
}

resource "aws_ecr_repository" "storefront" {
  name                 = "servd-storefront"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "KMS", kms_key = aws_kms_key.data.arn }
}

# ─── ECS Cluster ──────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "${var.app_name}-cluster"
  setting { name = "containerInsights", value = "enabled" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ─── CloudWatch log groups ────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.app_name}-api"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.app_name}-web"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "storefront" {
  name              = "/ecs/${var.app_name}-storefront"
  retention_in_days = 30
}

# ─── IAM: execution role (pulls images, writes logs, reads SSM at task start) ─

resource "aws_iam_role" "ecs_execution" {
  name = "${var.app_name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole", Effect = "Allow",
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "${var.app_name}-ecs-execution-secrets"
  role = aws_iam_role.ecs_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ssm:GetParameters", "ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/${var.app_name}/*"
      },
      {
        Effect = "Allow"
        Action = ["kms:Decrypt"]
        Resource = aws_kms_key.data.arn
      }
    ]
  })
}

# ─── IAM: task role (what the application itself can call at runtime) ─────────

resource "aws_iam_role" "ecs_task" {
  name = "${var.app_name}-ecs-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole", Effect = "Allow",
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_app" {
  name = "${var.app_name}-ecs-task-app"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
      }
    ]
  })
}

# ─── SSM Parameters (secrets) ─────────────────────────────────────────────────

resource "aws_ssm_parameter" "jwt_secret" {
  name      = "/${var.app_name}/JWT_SECRET"
  type      = "SecureString"
  value     = var.jwt_secret
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

resource "aws_ssm_parameter" "jwt_refresh_secret" {
  name      = "/${var.app_name}/JWT_REFRESH_SECRET"
  type      = "SecureString"
  value     = var.jwt_refresh_secret
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

resource "aws_ssm_parameter" "db_url" {
  name      = "/${var.app_name}/DATABASE_URL"
  type      = "SecureString"
  value     = "postgresql://servd:${var.db_password}@${aws_db_instance.postgres.address}:5432/servd?sslmode=require"
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

resource "aws_ssm_parameter" "redis_url" {
  name      = "/${var.app_name}/REDIS_URL"
  type      = "SecureString"
  value     = "rediss://:${var.redis_auth_token}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

resource "aws_ssm_parameter" "keenu_webhook_secret" {
  count     = var.keenu_webhook_secret == "" ? 0 : 1
  name      = "/${var.app_name}/KEENU_WEBHOOK_SECRET"
  type      = "SecureString"
  value     = var.keenu_webhook_secret
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

resource "aws_ssm_parameter" "foodpanda_webhook_secret" {
  count     = var.foodpanda_webhook_secret == "" ? 0 : 1
  name      = "/${var.app_name}/FOODPANDA_WEBHOOK_SECRET"
  type      = "SecureString"
  value     = var.foodpanda_webhook_secret
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

resource "aws_ssm_parameter" "careem_webhook_secret" {
  count     = var.careem_webhook_secret == "" ? 0 : 1
  name      = "/${var.app_name}/CAREEM_WEBHOOK_SECRET"
  type      = "SecureString"
  value     = var.careem_webhook_secret
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

resource "aws_ssm_parameter" "fbr_username" {
  count     = var.fbr_username == "" ? 0 : 1
  name      = "/${var.app_name}/FBR_USERNAME"
  type      = "SecureString"
  value     = var.fbr_username
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

resource "aws_ssm_parameter" "fbr_password" {
  count     = var.fbr_password == "" ? 0 : 1
  name      = "/${var.app_name}/FBR_PASSWORD"
  type      = "SecureString"
  value     = var.fbr_password
  key_id    = aws_kms_key.data.arn
  overwrite = true
}

# ─── Route 53 + ACM certificate (DNS-validated) ──────────────────────────────

data "aws_route53_zone" "main" {
  name         = "${var.domain}."
  private_zone = false
}

resource "aws_acm_certificate" "main" {
  domain_name               = var.domain
  subject_alternative_names = ["*.${var.domain}"]
  validation_method         = "DNS"

  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options :
    dvo.domain_name => { name = dvo.resource_record_name, type = dvo.resource_record_type, record = dvo.resource_record_value }
  }
  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# ─── ALB + listeners (HTTP→HTTPS redirect, host-routed HTTPS) ────────────────

resource "aws_lb" "main" {
  name               = "${var.app_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.vpc.public_subnets
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "api" {
  name        = "${var.app_name}-api-tg"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_target_group" "web" {
  name        = "${var.app_name}-web-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200-399"
  }
}

resource "aws_lb_target_group" "storefront" {
  name        = "${var.app_name}-sf-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200-399"
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition { host_header { values = [local.api_domain] } }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 110
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  condition { host_header { values = [local.web_domain] } }
}

resource "aws_lb_listener_rule" "storefront" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 120
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.storefront.arn
  }
  condition { host_header { values = [local.storefront_domain] } }
}

resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.api_domain
  type    = "A"
  alias { name = aws_lb.main.dns_name, zone_id = aws_lb.main.zone_id, evaluate_target_health = true }
}

resource "aws_route53_record" "web" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.web_domain
  type    = "A"
  alias { name = aws_lb.main.dns_name, zone_id = aws_lb.main.zone_id, evaluate_target_health = true }
}

resource "aws_route53_record" "storefront" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.storefront_domain
  type    = "A"
  alias { name = aws_lb.main.dns_name, zone_id = aws_lb.main.zone_id, evaluate_target_health = true }
}

# ─── ECS task definitions ─────────────────────────────────────────────────────

locals {
  api_secrets = concat(
    [
      { name = "DATABASE_URL",        valueFrom = aws_ssm_parameter.db_url.arn },
      { name = "REDIS_URL",           valueFrom = aws_ssm_parameter.redis_url.arn },
      { name = "JWT_SECRET",          valueFrom = aws_ssm_parameter.jwt_secret.arn },
      { name = "JWT_REFRESH_SECRET",  valueFrom = aws_ssm_parameter.jwt_refresh_secret.arn },
    ],
    var.keenu_webhook_secret == "" ? [] : [{ name = "KEENU_WEBHOOK_SECRET", valueFrom = aws_ssm_parameter.keenu_webhook_secret[0].arn }],
    var.foodpanda_webhook_secret == "" ? [] : [{ name = "FOODPANDA_WEBHOOK_SECRET", valueFrom = aws_ssm_parameter.foodpanda_webhook_secret[0].arn }],
    var.careem_webhook_secret == "" ? [] : [{ name = "CAREEM_WEBHOOK_SECRET", valueFrom = aws_ssm_parameter.careem_webhook_secret[0].arn }],
    var.fbr_username == "" ? [] : [{ name = "FBR_USERNAME", valueFrom = aws_ssm_parameter.fbr_username[0].arn }],
    var.fbr_password == "" ? [] : [{ name = "FBR_PASSWORD", valueFrom = aws_ssm_parameter.fbr_password[0].arn }],
  )
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.app_name}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
    essential = true
    portMappings = [{ containerPort = 3001, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV",       value = "production" },
      { name = "PORT",           value = "3001" },
      { name = "WEB_URL",        value = "https://${local.web_domain}" },
      { name = "STOREFRONT_URL", value = "https://${local.storefront_domain}" },
    ]
    secrets = local.api_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:3001/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.app_name}-web"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "web"
    image     = "${aws_ecr_repository.web.repository_url}:${var.web_image_tag}"
    essential = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV",             value = "production" },
      { name = "PORT",                 value = "3000" },
      { name = "NEXT_PUBLIC_API_URL",  value = "https://${local.api_domain}" },
      { name = "NEXT_PUBLIC_WS_URL",   value = "wss://${local.api_domain}" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.web.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "storefront" {
  family                   = "${var.app_name}-storefront"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "storefront"
    image     = "${aws_ecr_repository.storefront.repository_url}:${var.storefront_image_tag}"
    essential = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV",             value = "production" },
      { name = "PORT",                 value = "3000" },
      { name = "NEXT_PUBLIC_API_URL",  value = "https://${local.api_domain}" },
      { name = "NEXT_PUBLIC_WS_URL",   value = "wss://${local.api_domain}" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.storefront.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
}

# ─── ECS services ─────────────────────────────────────────────────────────────

resource "aws_ecs_service" "api" {
  name                               = "${var.app_name}-api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }

  depends_on = [aws_lb_listener.https]
  lifecycle { ignore_changes = [task_definition, desired_count] }  # CD pipeline owns these
}

resource "aws_ecs_service" "web" {
  name                               = "${var.app_name}-web"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = var.web_desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https]
  lifecycle { ignore_changes = [task_definition, desired_count] }
}

resource "aws_ecs_service" "storefront" {
  name                               = "${var.app_name}-storefront"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.storefront.arn
  desired_count                      = var.storefront_desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.storefront.arn
    container_name   = "storefront"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https]
  lifecycle { ignore_changes = [task_definition, desired_count] }
}

# ─── ECS autoscaling ──────────────────────────────────────────────────────────

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 2
  max_capacity       = 8
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.app_name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_target" "web" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 2
  max_capacity       = 6
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${var.app_name}-web-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = 65
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_target" "storefront" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.storefront.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 2
  max_capacity       = 8
}

resource "aws_appautoscaling_policy" "storefront_cpu" {
  name               = "${var.app_name}-storefront-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.storefront.service_namespace
  resource_id        = aws_appautoscaling_target.storefront.resource_id
  scalable_dimension = aws_appautoscaling_target.storefront.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = 65
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# ─── CloudWatch alarms (operational paging) ──────────────────────────────────

resource "aws_sns_topic" "alerts" {
  name = "${var.app_name}-alerts"
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.app_name}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions          = { DBInstanceIdentifier = aws_db_instance.postgres.id }
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.app_name}-rds-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions          = { DBInstanceIdentifier = aws_db_instance.postgres.id }
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.app_name}-alb-5xx-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
}

resource "aws_cloudwatch_metric_alarm" "alb_target_latency" {
  alarm_name          = "${var.app_name}-alb-latency-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Average"
  threshold           = 2
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  alarm_name          = "${var.app_name}-redis-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "EngineCPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 75
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions          = { CacheClusterId = "${aws_elasticache_replication_group.redis.id}-001" }
}

# Email subscription — created only when alert_email is provided so staging
# environments don't generate unwanted noise.
resource "aws_sns_topic_subscription" "alert_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ECS API service CPU — a sustained spike here means the API is under load or
# has a runaway process; scale-out should kick in first but alarm if it doesn't.
resource "aws_cloudwatch_metric_alarm" "ecs_api_cpu" {
  alarm_name          = "${var.app_name}-ecs-api-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 85
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.api.name
  }
}

# ECS API service memory — OOM kills silently restart containers; high memory
# sustained means a leak or under-provisioned task definition.
resource "aws_cloudwatch_metric_alarm" "ecs_api_memory" {
  alarm_name          = "${var.app_name}-ecs-api-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 85
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.api.name
  }
}

# Log-based ERROR metric — catches application-level errors that don't surface
# as HTTP 5xx (e.g. FBR compliance failures, BullMQ worker panics).
resource "aws_cloudwatch_log_metric_filter" "api_errors" {
  name           = "${var.app_name}-api-error-count"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "ERROR"

  metric_transformation {
    name          = "ApiErrorCount"
    namespace     = "${var.app_name}/App"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_error_rate" {
  alarm_name          = "${var.app_name}-api-error-rate-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApiErrorCount"
  namespace           = "${var.app_name}/App"
  period              = 60
  statistic           = "Sum"
  threshold           = 20
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# ─── Outputs ──────────────────────────────────────────────────────────────────

output "alb_dns"            { value = aws_lb.main.dns_name }
output "api_url"            { value = "https://${local.api_domain}" }
output "web_url"            { value = "https://${local.web_domain}" }
output "storefront_url"     { value = "https://${local.storefront_domain}" }
output "ecr_api"            { value = aws_ecr_repository.api.repository_url }
output "ecr_web"            { value = aws_ecr_repository.web.repository_url }
output "ecr_storefront"     { value = aws_ecr_repository.storefront.repository_url }
output "db_endpoint"        { value = aws_db_instance.postgres.address }
output "redis_endpoint"     { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "ecs_cluster"        { value = aws_ecs_cluster.main.name }
output "alerts_topic_arn"   { value = aws_sns_topic.alerts.arn }
