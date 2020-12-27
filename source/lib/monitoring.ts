/*********************************************************************************************************************
 *  Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/
import * as cdk from '@aws-cdk/core';
import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import * as lambda from '@aws-cdk/aws-lambda';
import * as events from "@aws-cdk/aws-events";
import * as logs from "@aws-cdk/aws-logs";
import * as targets from "@aws-cdk/aws-events-targets";
import * as eventsource from '@aws-cdk/aws-lambda-event-sources';
import * as iam from '@aws-cdk/aws-iam';
import * as iamSec from './iam-security';
import * as path from 'path';
import * as fs from 'fs';
import * as dynamo from "@aws-cdk/aws-dynamodb";

export interface MonitoringProps {
    readonly iamSecurity: iamSec.IamSecurity;
    readonly statusTable: dynamo.ITable
    readonly metricTable: dynamo.ITable
}

export class Monitoring extends cdk.Construct {

    public readonly dashboardName: string;

    constructor(scope: cdk.Construct, id: string, props: MonitoringProps) {
        super(scope, id);

        // -------------------------------------------------------------------------------------------
        // Calculate Metrics
        const calculateMetrics = new lambda.Function(this, 'calculateMetrics', {
            functionName: `${cdk.Aws.STACK_NAME}-calculateMetrics`,
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/calculateMetrics')),
            environment:
                {
                    METRICS_TABLE: props.metricTable.tableName
                }
        });

        const statusTableEventStream = new eventsource.DynamoEventSource(props.statusTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            parallelizationFactor: 1,
            maxBatchingWindow: cdk.Duration.seconds(30),
            batchSize: 1000
        });

        props.metricTable.grantReadWriteData(calculateMetrics);
        statusTableEventStream.bind(calculateMetrics);

        // -------------------------------------------------------------------------------------------
        // Post Metrics
        const postMetrics = new lambda.Function(this, 'postMetrics', {
            functionName: `${cdk.Aws.STACK_NAME}-postMetrics`,
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/postMetrics')),
            environment:
                {
                    METRICS_TABLE: props.metricTable.tableName,
                    STATUS_TABLE: props.statusTable.tableName,
                    STACK_NAME: cdk.Aws.STACK_NAME
                }
        });

        const postMetricSchedule = new events.Rule(this, 'postMetricSchedule', {
            schedule: {
                expressionString: 'rate(1 minute)'
            }
        });
        postMetricSchedule.addTarget(new targets.LambdaFunction(postMetrics));

        props.metricTable.grantReadData(postMetrics);
        postMetrics.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'permitPostMetrics',
                effect: iam.Effect.ALLOW,
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'cloudwatch:namespace': 'AmazonS3GlacierReFreezer'
                    }
                }
            }));

        // -------------------------------------------------------------------------------------------
        // Dashboard

        const totalArchives = Monitoring.createRefreezerMetric('Total Archives');
        const requested = Monitoring.createRefreezerMetric('Requested from Glacier');
        const initiated = Monitoring.createRefreezerMetric('Copy Initiated');
        const completed = Monitoring.createRefreezerMetric('Copy Completed');
        const validated = Monitoring.createRefreezerMetric('Hashes Validated');

        this.dashboardName = `${cdk.Aws.STACK_NAME}-Amazon-S3-Glacier-ReFreezer`;
        const dashboard = new cloudwatch.Dashboard(this, 'glacier-refreezer-dashboard',
            {
                dashboardName: this.dashboardName,
            });

        // single value
        const singleValueWidget = new cloudwatch.SingleValueWidget({
            width: 20,
            height: 3,
            title: `Amazon S3 Glacier Re:Freezer Progress Metrics : ${cdk.Aws.STACK_NAME}`,
            metrics: [
                totalArchives,
                requested,
                initiated,
                completed,
                validated
            ]
        });
        //singleValueFullPrecision

        // progress line
        const graphWidget = new cloudwatch.GraphWidget({
            title: 'Timeline',
            width: 20,
            height: 6,
            view: cloudwatch.GraphWidgetView.TIME_SERIES,
            left: [
                totalArchives,
                requested,
                initiated,
                completed,
                validated
            ]
        });

        // Log Groups and Log Widget
        // Pre-creating all log groups explicitly to remove them on Stack deletion automatically
        const logGroupNames: string[] = [
            Monitoring.createStackLogGroup(this, '/aws/states','stageTwoOrchestrator'),
        ];

        const directoryPath = path.join(__dirname, '../lambda');
        fs.readdirSync(directoryPath).map(entry => {
            if (fs.lstatSync(directoryPath + '/' + entry).isDirectory()) {
                if (entry === 'toLowercase') return;  // created in glue-data-catalog.ts
                if (entry === 'generateUuid') return;  // created in solution-builders-anonymous-statistics.cs
                logGroupNames.push(Monitoring.createStackLogGroup(this, '/aws/lambda', entry))
            }
        });

        const logWidget = new cloudwatch.LogQueryWidget({
            width: 20,
            height: 6,
            title: 'Errors',
            logGroupNames,
            view: cloudwatch.LogQueryVisualizationType.TABLE,
            queryLines: [
                'fields @timestamp, @message ',
                'filter @message like /error/ or @message like /Error/ or @message like /ERROR/',
                'sort by @timestamp desc'
            ]
        });

        // Oldest SQS Message Widget
        const sqsOldestMessageWidget = new cloudwatch.GraphWidget({
            title: 'Oldest SQS Message',
            width: 20,
            height: 6,
            view: cloudwatch.GraphWidgetView.TIME_SERIES,
            left: [
                Monitoring.createSqsMetric(`${cdk.Aws.STACK_NAME}-archiveQueue`),
                Monitoring.createSqsMetric(`${cdk.Aws.STACK_NAME}-chunkQueue`)
            ]
        });

        dashboard.addWidgets(singleValueWidget);
        dashboard.addWidgets(graphWidget);
        dashboard.addWidgets(logWidget);
        dashboard.addWidgets(sqsOldestMessageWidget);
    }

    private static createSqsMetric(queueName: string) {
        return new cloudwatch.Metric({
            unit: cloudwatch.Unit.NONE,
            metricName: 'ApproximateAgeOfOldestMessage',
            namespace: 'AWS/SQS',
            dimensions: {
                'QueueName': queueName
            }
        });
    }

    private static createRefreezerMetric(metricName: string) {
        return new cloudwatch.Metric({
            unit: cloudwatch.Unit.NONE,
            metricName,
            namespace: 'AmazonS3GlacierReFreezer',
            dimensions: {
                'CloudFormation Stack': cdk.Aws.STACK_NAME
            },
            account: cdk.Aws.ACCOUNT_ID,
            statistic: "max",
            period: cdk.Duration.minutes(5)
        });
    }

    private static createStackLogGroup(construct: cdk.Construct, prefix: string, name: string) {
        // Using direct CFN construct to enforce Log Group cleanup on stack deletion
        const logGroupName = `${prefix}/${cdk.Aws.STACK_NAME}-${name}`;
        new logs.CfnLogGroup(construct, `${name}LogGroup`, {logGroupName});
        return logGroupName;
    }
}