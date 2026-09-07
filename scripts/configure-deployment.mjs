import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const aws = (...args) =>
  JSON.parse(
    execFileSync("aws", [...args, "--output", "json"], { encoding: "utf8" }) ||
      "{}",
  );
const stack = aws(
  "cloudformation",
  "describe-stacks",
  "--stack-name",
  "magic-collection-keeper",
).Stacks[0];
if (
  stack.StackStatus !== "CREATE_COMPLETE" &&
  stack.StackStatus !== "UPDATE_COMPLETE"
)
  throw new Error(`Stack is ${stack.StackStatus}`);
const out = Object.fromEntries(
  stack.Outputs.map((r) => [r.OutputKey, r.OutputValue]),
);
writeFileSync("infra/outputs.json", JSON.stringify(out, null, 2));
writeFileSync(
  "public/config.json",
  JSON.stringify({
    region: "us-east-1",
    apiUrl: out.ApiUrl,
    clientId: out.ClientId,
  }),
);
const trust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        Federated:
          "arn:aws:iam::698643713254:oidc-provider/token.actions.githubusercontent.com",
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub":
            "repo:saintiago/magic-collection-keeper:ref:refs/heads/main",
        },
      },
    },
  ],
};
writeFileSync("infra/oidc-trust.json", JSON.stringify(trust, null, 2));
try {
  aws("iam", "get-role", "--role-name", "magic-collection-keeper-github");
  aws(
    "iam",
    "update-assume-role-policy",
    "--role-name",
    "magic-collection-keeper-github",
    "--policy-document",
    "file://infra/oidc-trust.json",
  );
} catch {
  aws(
    "iam",
    "create-role",
    "--role-name",
    "magic-collection-keeper-github",
    "--assume-role-policy-document",
    "file://infra/oidc-trust.json",
  );
}
const policy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: `arn:aws:s3:::${out.WebsiteBucket}`,
    },
    {
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"],
      Resource: `arn:aws:s3:::${out.WebsiteBucket}/*`,
    },
    {
      Effect: "Allow",
      Action: ["lambda:UpdateFunctionCode", "lambda:GetFunctionConfiguration"],
      Resource:
        "arn:aws:lambda:us-east-1:698643713254:function:magic-collection-keeper",
    },
    {
      Effect: "Allow",
      Action: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
      Resource: `arn:aws:cloudfront::698643713254:distribution/${out.DistributionId}`,
    },
  ],
};
writeFileSync("infra/deploy-policy.json", JSON.stringify(policy, null, 2));
aws(
  "iam",
  "put-role-policy",
  "--role-name",
  "magic-collection-keeper-github",
  "--policy-name",
  "DeployKeeperOnly",
  "--policy-document",
  "file://infra/deploy-policy.json",
);
for (const [name, value] of Object.entries({
  AWS_ROLE_ARN: "arn:aws:iam::698643713254:role/magic-collection-keeper-github",
  WEBSITE_BUCKET: out.WebsiteBucket,
  DISTRIBUTION_ID: out.DistributionId,
  API_URL: out.ApiUrl,
  COGNITO_CLIENT_ID: out.ClientId,
  WEBSITE_URL: out.WebsiteUrl,
}))
  execFileSync("gh", ["variable", "set", name, "--body", value], {
    stdio: "pipe",
  });
console.log(
  "Deployment role and repository variables configured.",
  out.WebsiteUrl,
);
