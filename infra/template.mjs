import { writeFileSync } from "node:fs";
const Ref = (name) => ({ Ref: name }),
  Get = (name, attr) => ({ "Fn::GetAtt": [name, attr] }),
  Sub = (text) => ({ "Fn::Sub": text });
const template = {
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "Isolated Magic Collection Keeper resources",
  Parameters: { CodeBucket: { Type: "String" }, CodeKey: { Type: "String" } },
  Resources: {
    CollectionTable: {
      Type: "AWS::DynamoDB::Table",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        TableName: "magic-collection-keeper",
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        TimeToLiveSpecification: { AttributeName: "expires", Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { SSEEnabled: true },
      },
    },
    UserPool: {
      Type: "AWS::Cognito::UserPool",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        UserPoolName: "magic-collection-keeper",
        AdminCreateUserConfig: {
          AllowAdminCreateUserOnly: true,
          InviteMessageTemplate: {
            EmailSubject: "Your Collection Keeper invitation",
            EmailMessage:
              "Your Collection Keeper username is {username} and your temporary password is {####}. Open the Collection Keeper link provided to you and choose a new password.",
          },
        },
        AutoVerifiedAttributes: ["email"],
        Policies: {
          PasswordPolicy: {
            MinimumLength: 12,
            RequireLowercase: true,
            RequireUppercase: true,
            RequireNumbers: true,
            RequireSymbols: true,
            TemporaryPasswordValidityDays: 7,
          },
        },
        Schema: [{ Name: "email", Required: true, Mutable: true }],
      },
    },
    UserClient: {
      Type: "AWS::Cognito::UserPoolClient",
      Properties: {
        UserPoolId: Ref("UserPool"),
        ClientName: "keeper-browser",
        GenerateSecret: false,
        ExplicitAuthFlows: [
          "ALLOW_USER_PASSWORD_AUTH",
          "ALLOW_REFRESH_TOKEN_AUTH",
        ],
        PreventUserExistenceErrors: "ENABLED",
        AccessTokenValidity: 1,
        IdTokenValidity: 1,
        RefreshTokenValidity: 30,
        SupportedIdentityProviders: ["COGNITO"],
      },
    },
    FunctionRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        },
        Policies: [
          {
            PolicyName: "keeper-storage",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: [
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem",
                    "dynamodb:Query",
                  ],
                  Resource: Get("CollectionTable", "Arn"),
                },
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                  Resource: Sub(
                    "arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/magic-collection-keeper:*",
                  ),
                },
              ],
            },
          },
        ],
      },
    },
    FunctionLogs: {
      Type: "AWS::Logs::LogGroup",
      Properties: {
        LogGroupName: "/aws/lambda/magic-collection-keeper",
        RetentionInDays: 14,
      },
    },
    ApiFunction: {
      Type: "AWS::Lambda::Function",
      DependsOn: "FunctionLogs",
      Properties: {
        FunctionName: "magic-collection-keeper",
        Runtime: "nodejs24.x",
        Handler: "cloud.handler",
        Role: Get("FunctionRole", "Arn"),
        MemorySize: 512,
        Timeout: 29,
        ReservedConcurrentExecutions: 1,
        Code: { S3Bucket: Ref("CodeBucket"), S3Key: Ref("CodeKey") },
        Environment: { Variables: { TABLE_NAME: Ref("CollectionTable") } },
      },
    },
    Api: {
      Type: "AWS::ApiGatewayV2::Api",
      Properties: {
        Name: "magic-collection-keeper",
        ProtocolType: "HTTP",
        CorsConfiguration: {
          AllowOrigins: [Sub("https://${Distribution.DomainName}")],
          AllowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
          AllowHeaders: ["authorization", "content-type"],
          MaxAge: 3600,
        },
      },
    },
    Authorizer: {
      Type: "AWS::ApiGatewayV2::Authorizer",
      Properties: {
        ApiId: Ref("Api"),
        AuthorizerType: "JWT",
        IdentitySource: ["$request.header.Authorization"],
        Name: "keeper-sign-in",
        JwtConfiguration: {
          Audience: [Ref("UserClient")],
          Issuer: Sub(
            "https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}",
          ),
        },
      },
    },
    Integration: {
      Type: "AWS::ApiGatewayV2::Integration",
      Properties: {
        ApiId: Ref("Api"),
        IntegrationType: "AWS_PROXY",
        IntegrationUri: Get("ApiFunction", "Arn"),
        PayloadFormatVersion: "2.0",
      },
    },
    Route: {
      Type: "AWS::ApiGatewayV2::Route",
      Properties: {
        ApiId: Ref("Api"),
        RouteKey: "ANY /api/{proxy+}",
        AuthorizationType: "JWT",
        AuthorizerId: Ref("Authorizer"),
        Target: Sub("integrations/${Integration}"),
      },
    },
    Stage: {
      Type: "AWS::ApiGatewayV2::Stage",
      Properties: {
        ApiId: Ref("Api"),
        StageName: "$default",
        AutoDeploy: true,
        DefaultRouteSettings: {
          ThrottlingBurstLimit: 30,
          ThrottlingRateLimit: 20,
        },
      },
    },
    InvokePermission: {
      Type: "AWS::Lambda::Permission",
      Properties: {
        FunctionName: Ref("ApiFunction"),
        Action: "lambda:InvokeFunction",
        Principal: "apigateway.amazonaws.com",
        SourceArn: Sub(
          "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*/api/*",
        ),
      },
    },
    Website: {
      Type: "AWS::S3::Bucket",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      },
    },
    OriginAccess: {
      Type: "AWS::CloudFront::OriginAccessControl",
      Properties: {
        OriginAccessControlConfig: {
          Name: "magic-collection-keeper",
          OriginAccessControlOriginType: "s3",
          SigningBehavior: "always",
          SigningProtocol: "sigv4",
        },
      },
    },
    Headers: {
      Type: "AWS::CloudFront::ResponseHeadersPolicy",
      Properties: {
        ResponseHeadersPolicyConfig: {
          Name: "magic-collection-keeper",
          SecurityHeadersConfig: {
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: "DENY", Override: true },
            ReferrerPolicy: {
              ReferrerPolicy: "strict-origin-when-cross-origin",
              Override: true,
            },
            StrictTransportSecurity: {
              AccessControlMaxAgeSec: 31536000,
              Override: true,
            },
          },
          CustomHeadersConfig: {
            Items: [
              {
                Header: "Content-Security-Policy",
                Value:
                  "default-src 'self'; img-src 'self' blob: data: https://cards.scryfall.io; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://*.execute-api.us-east-1.amazonaws.com https://cognito-idp.us-east-1.amazonaws.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
                Override: true,
              },
              {
                Header: "Permissions-Policy",
                Value: "camera=(self), microphone=()",
                Override: true,
              },
            ],
          },
        },
      },
    },
    Distribution: {
      Type: "AWS::CloudFront::Distribution",
      Properties: {
        DistributionConfig: {
          Enabled: true,
          DefaultRootObject: "index.html",
          PriceClass: "PriceClass_100",
          Origins: [
            {
              Id: "site",
              DomainName: Get("Website", "RegionalDomainName"),
              OriginAccessControlId: Ref("OriginAccess"),
              S3OriginConfig: { OriginAccessIdentity: "" },
            },
          ],
          DefaultCacheBehavior: {
            TargetOriginId: "site",
            ViewerProtocolPolicy: "redirect-to-https",
            AllowedMethods: ["GET", "HEAD", "OPTIONS"],
            CachedMethods: ["GET", "HEAD"],
            Compress: true,
            CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
            ResponseHeadersPolicyId: Ref("Headers"),
          },
        },
      },
    },
    WebsitePolicy: {
      Type: "AWS::S3::BucketPolicy",
      Properties: {
        Bucket: Ref("Website"),
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:GetObject",
              Resource: Sub("${Website.Arn}/*"),
              Condition: {
                StringEquals: {
                  "AWS:SourceArn": Sub(
                    "arn:aws:cloudfront::${AWS::AccountId}:distribution/${Distribution}",
                  ),
                },
              },
            },
          ],
        },
      },
    },
  },
  Outputs: {
    WebsiteUrl: { Value: Sub("https://${Distribution.DomainName}") },
    WebsiteBucket: { Value: Ref("Website") },
    DistributionId: { Value: Ref("Distribution") },
    ApiUrl: { Value: Get("Api", "ApiEndpoint") },
    UserPoolId: { Value: Ref("UserPool") },
    ClientId: { Value: Ref("UserClient") },
    FunctionName: { Value: Ref("ApiFunction") },
  },
};
const headers =
  template.Resources.Headers.Properties.ResponseHeadersPolicyConfig;
template.Resources.PreflightRoute = {
  Type: "AWS::ApiGatewayV2::Route",
  Properties: {
    ApiId: Ref("Api"),
    RouteKey: "OPTIONS /api/{proxy+}",
    AuthorizationType: "NONE",
    Target: Sub("integrations/${Integration}"),
  },
};
delete template.Resources.ApiFunction.Properties.ReservedConcurrentExecutions;
const csp = headers.CustomHeadersConfig.Items.shift();
headers.SecurityHeadersConfig.ContentSecurityPolicy = {
  ContentSecurityPolicy: csp.Value,
  Override: true,
};
for (const resource of Object.values(template.Resources))
  if (resource.DeletionPolicy === "Retain")
    resource.DeletionPolicy = "RetainExceptOnCreate";
writeFileSync("infra/template.json", JSON.stringify(template, null, 2));
