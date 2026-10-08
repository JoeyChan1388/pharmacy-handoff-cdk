#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';

const app = new cdk.App();
const dataStack = new DataStack(app, 'PharmacyHandoffData');
const authStack = new AuthStack(app, 'PharmacyHandoffAuth', {
	usersTable: dataStack.usersTable,
});
