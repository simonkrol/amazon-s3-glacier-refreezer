"""
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
"""

import logging
import json
from typing import Any, Dict, TYPE_CHECKING
import io
import csv
import boto3

if TYPE_CHECKING:
    from mypy_boto3_glacier.client import GlacierClient
    from mypy_boto3_glacier.type_defs import (
        GetJobOutputOutputTypeDef,
        JobParametersTypeDef,
    )
else:
    GlacierClient = object
    GetJobOutputOutputTypeDef = object
    JobParametersTypeDef = object

logger = logging.getLogger()
logger.setLevel(logging.INFO)


class MockGlacierVault:
    def __init__(self, vault_name: str) -> None:
        self.vault_name = vault_name
        self.glacier: GlacierClient = boto3.client("glacier")
        self.glacier.create_vault(vaultName=vault_name)
        self.mock_vault_mapping: Dict[Any, Any] = {}
        self.inventory_job_id = ""

    def initiate_job(
        self,
        job_parameters: JobParametersTypeDef = {},
    ) -> str:
        self.mock_vault_mapping.setdefault("initiate-job", {})
        glacier_initiate_job_response = self.glacier.initiate_job(
            vaultName=self.vault_name, jobParameters=job_parameters
        )
        del glacier_initiate_job_response["ResponseMetadata"]["HTTPHeaders"]  # type: ignore

        mapping_key = job_parameters["Type"]
        if job_parameters["Type"] == "archive-retrieval":
            mapping_key = f"{mapping_key}:{job_parameters['ArchiveId']}"
        else:
            self.inventory_job_id = glacier_initiate_job_response["jobId"]
        self.mock_vault_mapping["initiate-job"][
            mapping_key
        ] = glacier_initiate_job_response
        return glacier_initiate_job_response["jobId"]

    def upload_archive(self, body: str, archive_description: str) -> str:
        return self.glacier.upload_archive(
            vaultName=self.vault_name,
            body=bytes(body, "utf-8"),
            archiveDescription=archive_description,
        )["archiveId"]

    def get_job_output(self, job_id: str, range: str = "") -> GetJobOutputOutputTypeDef:
        self.mock_vault_mapping.setdefault("get-job-output", {})
        glacier_job_output_response = self.glacier.get_job_output(
            vaultName=self.vault_name, jobId=job_id, range=range
        )
        del glacier_job_output_response["ResponseMetadata"]["HTTPHeaders"]  # type: ignore
        glacier_job_output_response["body"] = glacier_job_output_response["body"].read()  # type: ignore

        if not range:
            glacier_job_output_response["body"] = glacier_job_output_response["body"].decode("utf-8")  # type: ignore
            if job_id == self.inventory_job_id:
                glacier_job_output_response["body"] = self._json_inventory_to_csv(glacier_job_output_response["body"])  # type: ignore
            self.mock_vault_mapping["get-job-output"][
                job_id
            ] = glacier_job_output_response
        else:
            start_byte, end_byte = range.split("=")[1].split("-")
            glacier_job_output_response["body"] = glacier_job_output_response["body"][int(start_byte) : int(end_byte) + 1].decode("utf-8")  # type: ignore
            self.mock_vault_mapping["get-job-output"].setdefault(job_id, {})
            self.mock_vault_mapping["get-job-output"][job_id][
                range
            ] = glacier_job_output_response
        return glacier_job_output_response

    def _json_inventory_to_csv(self, json_data: str) -> str:
        archives = json.loads(json_data)["ArchiveList"]
        output = io.StringIO()
        fields = [
            "ArchiveId",
            "ArchiveDescription",
            "CreationDate",
            "Size",
            "SHA256TreeHash",
        ]
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        for archive in archives:
            writer.writerow(archive)
        return output.getvalue()

    def mock_data(self) -> Dict[str, Any]:
        return {self.vault_name: self.mock_vault_mapping}
