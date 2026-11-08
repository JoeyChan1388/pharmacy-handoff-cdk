import { Aspects, type IAspect } from "aws-cdk-lib/core";
import {
  NodejsFunction,
  type NodejsFunctionProps,
} from "aws-cdk-lib/aws-lambda-nodejs";

import type { IConstruct } from "constructs";

/**
 * Lambda Memory
 *
 * Lambda gives CPU in proportion to memory. At the 128 MB default a Node
 * cold start takes over a second; 1024 MB cuts it sharply for a negligible
 * cost at this traffic level. Lower it per function if a bill ever says so.
 */
export const LAMBDA_MEMORY_MB = 1024;

/**
 * Node.js Function Defaults
 *
 * Shared by every NodejsFunction so cold-start tuning lives in one place:
 * more memory (and so CPU), and smaller minified bundles with source maps
 * (NodejsFunction enables Node's source map support when sourceMap is on, so
 * stack traces in CloudWatch still point at the original TypeScript).
 *
 * Only the SDK clients and the DynamoDB document client are left to the
 * Lambda runtime. Helper packages such as the S3 presigner are bundled,
 * because the runtime does not guarantee they are present.
 */
export const nodejsFunctionDefaults = {
  memorySize: LAMBDA_MEMORY_MB,
  bundling: {
    minify: true,
    sourceMap: true,
    externalModules: ["@aws-sdk/client-*", "@aws-sdk/lib-dynamodb"],
  },
} satisfies Partial<NodejsFunctionProps>;

/**
 * Enables Node's source map support on every NodejsFunction in a scope, so
 * stack traces from minified bundles point at the original TypeScript. CDK
 * emits the maps but does not turn this on itself. An aspect is used because
 * each function defines its own environment, which would replace a default.
 *
 * @param scope The stack (or other construct) whose functions to configure
 */
export function enableSourceMaps(scope: IConstruct): void {
  const aspect: IAspect = {
    visit(node) {
      if (node instanceof NodejsFunction) {
        node.addEnvironment("NODE_OPTIONS", "--enable-source-maps");
      }
    },
  };
  Aspects.of(scope).add(aspect);
}
