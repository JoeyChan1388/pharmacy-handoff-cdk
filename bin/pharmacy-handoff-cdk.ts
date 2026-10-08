#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';

const app = new cdk.App();
new AuthStack(app, 'PharmacyHandoffAuth');
new DataStack(app, 'PharmacyHandoffData');
