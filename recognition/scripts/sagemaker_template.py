"""Generate a concrete, isolated administrator-review template; never deploys."""

import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
ref = lambda name: {"Ref": name}
sub = lambda value: {"Fn::Sub": value}
attr = lambda name, key="Arn": {"Fn::GetAtt": [name, key]}
statement = lambda actions, resource: {
    "Effect": "Allow",
    "Action": actions,
    "Resource": resource,
}


def role(service, statements):
    trust = {
        "Effect": "Allow",
        "Principal": {"Service": service},
        "Action": "sts:AssumeRole",
    }
    if service == "sagemaker.amazonaws.com":
        trust["Condition"] = {
            "StringEquals": {"aws:SourceAccount": ref("AWS::AccountId")},
            "ArnLike": {
                "aws:SourceArn": sub(
                    "arn:${AWS::Partition}:sagemaker:${AWS::Region}:${AWS::AccountId}:*"
                )
            },
        }
    return {
        "Type": "AWS::IAM::Role",
        "Properties": {
            "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [trust]},
            "Policies": [
                {
                    "PolicyName": "IsolatedRecognition",
                    "PolicyDocument": {
                        "Version": "2012-10-17",
                        "Statement": statements,
                    },
                }
            ],
        },
    }


def log_policy(name):
    return statement(
        ["logs:CreateLogStream", "logs:PutLogEvents"],
        sub(
            "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:"
            + name
            + ":*"
        ),
    )


resources = {
    "ModelLogs": {
        "Type": "AWS::Logs::LogGroup",
        "Properties": {
            "LogGroupName": "/aws/sagemaker/Endpoints/magic-keeper-sagemaker",
            "RetentionInDays": 7,
        },
    },
    "ProxyLogs": {
        "Type": "AWS::Logs::LogGroup",
        "Properties": {
            "LogGroupName": "/aws/lambda/magic-keeper-sagemaker-proxy",
            "RetentionInDays": 7,
        },
    },
    "ModelRole": role(
        "sagemaker.amazonaws.com",
        [
            statement(["ecr:GetAuthorizationToken"], "*"),
            statement(
                [
                    "ecr:BatchGetImage",
                    "ecr:GetDownloadUrlForLayer",
                    "ecr:BatchCheckLayerAvailability",
                ],
                sub(
                    "arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/magic-keeper-recognition"
                ),
            ),
            log_policy("/aws/sagemaker/Endpoints/magic-keeper-sagemaker"),
        ],
    ),
    "ProxyRole": role(
        "lambda.amazonaws.com",
        [
            statement(
                ["sagemaker:InvokeEndpoint"],
                sub(
                    "arn:${AWS::Partition}:sagemaker:${AWS::Region}:${AWS::AccountId}:endpoint/magic-keeper-sagemaker"
                ),
            ),
            log_policy("/aws/lambda/magic-keeper-sagemaker-proxy"),
        ],
    ),
    "Model": {
        "Type": "AWS::SageMaker::Model",
        "Properties": {
            "ExecutionRoleArn": attr("ModelRole"),
            "PrimaryContainer": {
                "Image": ref("ImageUri"),
                "Environment": {"ORT_DISABLE_TELEMETRY": "1"},
            },
        },
    },
    "EndpointConfig": {
        "Type": "AWS::SageMaker::EndpointConfig",
        "Properties": {
            "ProductionVariants": [
                {
                    "VariantName": "AllTraffic",
                    "ModelName": ref("Model"),
                    "ServerlessConfig": {"MemorySizeInMB": 4096, "MaxConcurrency": 2},
                }
            ],
        },
    },
    "Endpoint": {
        "Type": "AWS::SageMaker::Endpoint",
        "DependsOn": "ModelLogs",
        "Properties": {
            "EndpointName": "magic-keeper-sagemaker",
            "EndpointConfigName": ref("EndpointConfig"),
        },
    },
    "Proxy": {
        "Type": "AWS::Lambda::Function",
        "DependsOn": "ProxyLogs",
        "Properties": {
            "FunctionName": "magic-keeper-sagemaker-proxy",
            "Runtime": "python3.12",
            "Handler": "index.handler",
            "MemorySize": 256,
            "Timeout": 28,
            "Role": attr("ProxyRole"),
            "Environment": {"Variables": {"ENDPOINT_NAME": ref("Endpoint")}},
            "Code": {"ZipFile": (root / "sagemaker_proxy.py").read_text()},
        },
    },
    "Integration": {
        "Type": "AWS::ApiGatewayV2::Integration",
        "Properties": {
            "ApiId": "exex6mzt02",
            "IntegrationType": "AWS_PROXY",
            "IntegrationUri": attr("Proxy"),
            "PayloadFormatVersion": "2.0",
            "TimeoutInMillis": 29000,
        },
    },
    "Route": {
        "Type": "AWS::ApiGatewayV2::Route",
        "Properties": {
            "ApiId": "exex6mzt02",
            "RouteKey": "POST /api/recognize/sagemaker",
            "AuthorizationType": "JWT",
            "AuthorizerId": "giiovd",
            "Target": {"Fn::Join": ["/", ["integrations", ref("Integration")]]},
        },
    },
    "Permission": {
        "Type": "AWS::Lambda::Permission",
        "Properties": {
            "Action": "lambda:InvokeFunction",
            "FunctionName": ref("Proxy"),
            "Principal": "apigateway.amazonaws.com",
            "SourceArn": sub(
                "arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:exex6mzt02/*/POST/api/recognize/sagemaker"
            ),
        },
    },
}
template = {
    "AWSTemplateFormatVersion": "2010-09-09",
    "Description": "Keeper SageMaker comparison only. No provisioned concurrency, inventory access, S3 model bucket, CI role edits or pantry resources.",
    "Parameters": {
        "ImageUri": {
            "Type": "String",
            "AllowedPattern": "^698643713254\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/magic-keeper-recognition@sha256:[0-9a-f]{64}$",
        }
    },
    "Resources": resources,
}
(root / "sagemaker-review-template.json").write_text(
    json.dumps(template, indent=2) + "\n"
)
