import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as Monolithic from '../lib/monolithic-stack';

//
//  Usage:
//    export CDK_DEPLOY_REGION=<your region>
//    export CDK_DEPLOY_ACCOUNT=<your account>
//    npm test
//
describe("Monolithic", () => {
  test("matches the snapshot", () => {
    const app = new cdk.App();
    const stack = new Monolithic.MonolithicStack(app, 'MonolithicStack', {
      env: {
        // NOTE: CDK_DEFAULT_ACCOUNT/CDK_DEFAULT_REGION are not set in the test environment
        account: process.env.CDK_DEPLOY_ACCOUNT,
        region: process.env.CDK_DEPLOY_REGION
      }
    });

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});