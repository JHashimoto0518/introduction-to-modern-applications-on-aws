#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MonolithicStack } from '../lib/monolithic-stack';

const app = new cdk.App();
new MonolithicStack(app, 'MonolithicStack');
