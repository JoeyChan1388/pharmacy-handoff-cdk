import * as cdk from 'aws-cdk-lib/core';

import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';

const app = new cdk.App();
const dataStack = new DataStack(app, 'PharmacyHandoffData');
const authStack = new AuthStack(app, 'PharmacyHandoffAuth', {
	usersTable: dataStack.usersTable,
});
const apiStack = new ApiStack(app, 'PharmacyHandoffApi', {
	usersTable: dataStack.usersTable,
	staffUserPool: authStack.staffUserPool,
	patientUserPool: authStack.patientUserPool,
});
