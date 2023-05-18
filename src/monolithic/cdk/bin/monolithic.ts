#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MonolithicStack } from '../lib/monolithic-stack';

const app = new cdk.App();
new MonolithicStack(app, 'MonolithicStack', {
  // See: https://docs.aws.amazon.com/cdk/v2/guide/environments.html
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});
