/*********************************************************************************************************************
 *  Copyright 2019-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                      *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/                                                                               *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * @author Solution Builders
 */

'use strict';

const AWS = require("aws-sdk");
const s3 = new AWS.S3();
const dynamodb = new AWS.DynamoDB();
const glacier = new AWS.Glacier({maxRetries: 50});
const athena = new AWS.Athena();

const moment = require("moment");
const csv = require("csv-parser");

var parseFileName = require("./lib/filenameparser.js").parseFileName;

const CHUNK_SIZE = 4 * 1024 * 1024 * 1024;

const {
    STAGING_BUCKET,
    STATUS_TABLE,
    VAULT,
    TIER,
    SNS_TOPIC,
    DATABASE,
    PARTITIONED_INVENTORY_TABLE,
    ATHENA_WORKGROUP
} = process.env;

async function handler(payload) {
    // Using an array to supplement DynamoDB check for the recently updated files.
    // Just in case the GSI index has not been synced for the recently added filename
    const processed = [];

    console.log(
        `Starting partition: ${payload.nextPartition}. Last partition: ${payload.maxPartition}`
    );

    console.log(`Checking progress in DynamoDB`);
    const pid = payload.nextPartition;
    var partitionMaxProcessedFileNumber = await getPartitionMaxProcessedFileNumber(
        pid
    );
    console.log(`Max Processed File Number : ${partitionMaxProcessedFileNumber}`);

    var resultsCSV = await readAthenaPartition(pid);
    console.log(`Reading athena results file: ${resultsCSV}`);

    const lines = await readResultsCSV(resultsCSV);

    for (const line of lines) {
        const {
            row_num: ifn,
            size: sz,
            archiveid: aid,
            sha256treehash: sha,
            archivedescription: descr,
            creationdate: creationdate,
        } = line;

        if (ifn <= partitionMaxProcessedFileNumber) {
            continue;
        }

        console.log(`${ifn} : ${aid}`);
        let fname = parseFileName(aid, descr);

        // Duplicates - adding creation date suffix
        if (processed.includes(fname) || (await filenameExists(fname))) {
            fname += `-${creationdate}`;
        }

        console.log(`${fname}`);
        const glacierJob = await glacier
            .initiateJob({
                accountId: "-",
                jobParameters: {
                    Type: "archive-retrieval",
                    ArchiveId: aid,
                    Tier: TIER,
                    SNSTopic: SNS_TOPIC,
                },
                vaultName: VAULT,
            })
            .promise();

        const jobId = glacierJob.jobId;

        const cdt = moment().format();
        const cc = calculateNumberOfChunks(sz);
        const rc = 0; // Retry count is initiated to 0
        await dynamodb
            .putItem({
                Item: AWS.DynamoDB.Converter.marshall({
                    aid,
                    jobId,
                    ifn,
                    pid,
                    sha,
                    sz,
                    cdt,
                    descr,
                    fname,
                    cc,
                    rc,
                }),
                TableName: STATUS_TABLE,
            })
            .promise();

        processed.push(fname);
        partitionMaxProcessedFileNumber = ifn;
    }

    // Increment Processed Partition Count
    payload.nextPartition = pid + 1;
    return payload;
};

async function readAthenaPartition(partNumber) {
    console.log("Starting query");

    const queryExecution = await athena
        .startQueryExecution({
            QueryString: `select distinct row_num, archiveid, "size", sha256treehash, creationdate, archivedescription from "${DATABASE}"."${PARTITIONED_INVENTORY_TABLE}" where part=${partNumber} order by row_num`,
            QueryExecutionContext: {
                Database: DATABASE,
            },
            ResultConfiguration: {
                OutputLocation: `s3://${STAGING_BUCKET}/results/`,
            },
            WorkGroup: ATHENA_WORKGROUP
        })
        .promise();

    const QueryExecutionId = queryExecution.QueryExecutionId;
    var runComplete = false;

    console.log(`QueryID : ${QueryExecutionId}`);

    while (!runComplete) {
        console.log("Waiting for Athena Query to complete");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const result = await athena
            .getQueryExecution({QueryExecutionId})
            .promise();
        if (!["QUEUED", "RUNNING", "SUCCEEDED"].includes(result.QueryExecution.Status.State)){
            console.error(`${JSON.stringify(result)}`)
            throw "Athena exception";
        }
        runComplete = result.QueryExecution.Status.State === "SUCCEEDED";
    }

    return `results/${QueryExecutionId}.csv`;
}

function readResultsCSV(key) {
    return new Promise((resolve) => {
        const lines = [];
        s3.getObject({
            Bucket: STAGING_BUCKET,
            Key: key,
        })
            .createReadStream()
            .pipe(csv())
            .on("data", (data) => {
                data["size"] = parseInt(data["size"]);
                data["row_num"] = parseInt(data["row_num"]);
                lines.push(data);
            })
            .on("end", () => {
                console.log(`Length : ${lines.length}`);
                resolve(lines);
            });
    });
}

async function getPartitionMaxProcessedFileNumber(pid) {
    console.log(`Checking last file number for partition : ${pid}`);
    let result = await dynamodb
        .query({
            TableName: STATUS_TABLE,
            IndexName: "max-file-index",
            KeyConditionExpression: "pid = :pid",
            ExpressionAttributeValues: {
                ":pid": {N: pid.toString()},
            },
            ProjectionExpression: "ifn",
            ScanIndexForward: false,
            Limit: 1,
        })
        .promise();

    if (result.Count == 0) {
        console.log(
            `No records for partition ${pid} found. Setting the last item number to 0`
        );
        return 0;
    }

    const lastIfn = parseInt(result.LastEvaluatedKey.ifn.N);
    const aid = result.LastEvaluatedKey.aid.S;
    console.log(`Last registered item is ${lastIfn}. ArchiveID (aid): ${aid} `);
    return lastIfn;
}

const filenameExists = async (fname) => {
    let result = await dynamodb
        .query({
            TableName: STATUS_TABLE,
            IndexName: "name-index",
            KeyConditionExpression: "fname = :fname",
            ExpressionAttributeValues: {
                ":fname": {S: fname},
            },
            Select: "COUNT",
            Limit: 1,
        })
        .promise();

    return result.Count !== 0;
};

function calculateNumberOfChunks(sizeInBytes) {
    let numberOfChunks = Math.floor(sizeInBytes / CHUNK_SIZE);
    if (sizeInBytes % CHUNK_SIZE !== 0) {
        numberOfChunks++;
    }
    return numberOfChunks;
}

module.exports = {
    handler,
    readAthenaPartition,
    getPartitionMaxProcessedFileNumber
};
