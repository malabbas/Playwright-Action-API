#!/usr/bin/env python3
"""Add an ACI DNS label using its complete exported deployment. Dry-run by default."""

import argparse
import copy
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import warnings

try:
    import yaml
except ImportError:
    yaml = None


class SafeError(Exception):
    """An operator-facing error that never contains subprocess output or secrets."""


def az(*args):
    try:
        result = subprocess.run(
            ["az", *args, "--only-show-errors"], capture_output=True, text=True,
            timeout=1200,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SafeError("Azure CLI did not complete. Check Azure Portal before retrying; a submitted update may still be running.") from None
    if result.returncode:
        raise SafeError("Azure CLI reported a failure. Check the resource's deployment/activity status in Azure Portal. No delete or rollback was requested.")
    return result.stdout


def read_json(*args):
    try:
        return json.loads(az(*args, "--output", "json"))
    except (ValueError, TypeError):
        raise SafeError("Azure CLI returned an unexpected response; no further action was taken.") from None


def normalized(document):
    document = copy.deepcopy(document)
    for key in ("id", "etag"):
        document.pop(key, None)
    props = document.get("properties") or {}
    for key in ("instanceView", "provisioningState"):
        props.pop(key, None)
    for container in (props.get("containers") or []) + (props.get("initContainers") or []):
        container.get("properties", {}).pop("instanceView", None)
    for key in ("ip", "fqdn"):
        props.get("ipAddress", {}).pop(key, None)
    return document


def validate(document, name):
    if document.get("name") != name or not document.get("location"):
        raise SafeError("Exported container name/location did not match the requested resource.")
    props = document.get("properties") or {}
    if props.get("ipAddress", {}).get("type", "").lower() != "public":
        raise SafeError("This helper supports existing public container groups only.")
    if not props.get("containers"):
        raise SafeError("Export contains no containers.")
    containers = (props.get("containers") or []) + (props.get("initContainers") or [])
    for container in containers:
        config = container.get("properties", {})
        if not config.get("image"):
            raise SafeError("A container image is missing from the export.")
        if container in props.get("containers", []):
            requests = config.get("resources", {}).get("requests", {})
            if not requests.get("cpu") or not requests.get("memoryInGB"):
                raise SafeError("CPU or memory is missing from the ARM export; no update was attempted.")
        for variable in config.get("environmentVariables") or []:
            if "secureValue" in variable or "value" not in variable:
                raise SafeError("Secure environment variables cannot be recovered by export. Use the original deployment definition and secret source.")
    for volume in props.get("volumes") or []:
        if "secret" in volume or "azureFile" in volume:
            raise SafeError("This group uses secret/storage credentials that export may omit. Use the original deployment definition instead.")
    if (props.get("diagnostics") or {}).get("logAnalytics") or props.get("extensions"):
        raise SafeError("This group has diagnostics/extensions that may contain non-exportable secrets. Use the original deployment definition.")
    registries = props.get("imageRegistryCredentials") or []
    for container in containers:
        server = container["properties"]["image"].split("/")[0]
        if server.endswith(".azurecr.io") and not any(c.get("server") == server for c in registries):
            raise SafeError("A private ACR image has no exported registry authentication. Use the original deployment definition.")
    for credential in registries:
        server = credential.get("server", "")
        if not re.fullmatch(r"[a-z0-9-]+\.azurecr\.io", server):
            raise SafeError("This helper supports Azure Container Registry credentials only.")
        images = [c.get("properties", {}).get("image", "") for c in containers]
        if not any(image.startswith(server + "/") for image in images):
            raise SafeError("A registry credential does not match any container image; no update was attempted.")
        if credential.get("username") == "00000000-0000-0000-0000-000000000000":
            raise SafeError("Registry authentication uses a temporary-token username. Configure durable pull credentials or managed identity before this update.")


def hidden_password():
    try:
        with open("/dev/tty", "r+") as terminal, warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("Original durable registry password (hidden; enter here, never in chat): ", stream=terminal)
    except (OSError, EOFError, getpass.GetPassWarning):
        raise SafeError("A secure interactive terminal is required for the registry password. Nothing was deployed.") from None
    if not password:
        raise SafeError("No registry password was supplied. Nothing was deployed.")
    return password


def restore_registry_passwords(document, use_existing_admin, subscription):
    for credential in document["properties"].get("imageRegistryCredentials") or []:
        if credential.get("identity") or credential.get("password"):
            continue
        if not credential.get("username"):
            raise SafeError("Registry username is missing. Use the original deployment definition and durable pull credentials.")
        if use_existing_admin:
            registry = credential["server"].split(".")[0]
            enabled = read_json("acr", "show", "--name", registry, "--query", "adminUserEnabled", "--subscription", subscription)
            if enabled is not True:
                raise SafeError("ACR admin access is not already enabled. Nothing was changed. Run without --use-existing-acr-admin to enter the original durable password privately.")
            credentials = read_json("acr", "credential", "show", "--name", registry, "--subscription", subscription)
            if credentials.get("username") != credential["username"]:
                raise SafeError("The existing registry username is not the ACR admin user. Run without --use-existing-acr-admin to enter its original durable password privately.")
            passwords = credentials.get("passwords", [])
            password = next((p.get("value") for p in passwords if p.get("value")), None)
            if not password:
                raise SafeError("The original registry credential could not be recovered. Nothing was deployed.")
            credential["password"] = password
        else:
            credential["password"] = hidden_password()


def export_group(resource_group, name, file_path, subscription):
    az("container", "export", "--resource-group", resource_group, "--name", name, "--file", str(file_path), "--subscription", subscription, "--output", "none")
    file_path.chmod(0o600)
    try:
        document = yaml.safe_load(file_path.read_text())
    except (ValueError, yaml.YAMLError):
        raise SafeError("The container export could not be parsed. Nothing was deployed.") from None
    if not isinstance(document, dict):
        raise SafeError("The container export was empty. Nothing was deployed.")
    return normalized(document)


def print_hostname(args, subscription):
    result = read_json("container", "show", "--resource-group", args.resource_group, "--name", args.name, "--subscription", subscription, "--query", "{fqdn:ipAddress.fqdn,state:provisioningState}")
    fqdn = result.get("fqdn")
    if not fqdn or not re.fullmatch(r"[a-zA-Z0-9.-]+", fqdn):
        raise SafeError("No hostname was returned. Inspect Overview and deployment status in Azure Portal before retrying.")
    print("DNS hostname: " + fqdn)
    print("Health check (no credentials): http://" + fqdn + ":3000/health")
    print("Add HTTPS before transmitting API tokens or sharing a public demo.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resource-group", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--dns-name-label", required=True)
    parser.add_argument("--apply", action="store_true", help="Apply the update and restart the existing group; default is read-only.")
    parser.add_argument("--use-existing-acr-admin", action="store_true", help="Privately recover existing admin credentials only when admin is already enabled and the current registry username matches. Never enables or rotates admin access.")
    args = parser.parse_args(argv)
    if yaml is None:
        raise SafeError("PyYAML is required. Install it in Cloud Shell with: python3 -m pip install --user PyYAML==6.0.3. No Azure changes were made.")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,61}[a-z0-9]", args.dns_name_label):
        raise SafeError("Choose a lowercase DNS label of 3–63 letters, digits, or hyphens, starting with a letter and ending with a letter/digit.")
    account = read_json("account", "show", "--query", "id")
    if not isinstance(account, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", account):
        raise SafeError("The selected Azure subscription ID could not be verified.")
    resource_id = read_json("container", "show", "--resource-group", args.resource_group, "--name", args.name, "--subscription", account, "--query", "id")
    expected_id = f"/subscriptions/{account}/resourceGroups/{args.resource_group}/providers/Microsoft.ContainerInstance/containerGroups/{args.name}"
    if not isinstance(resource_id, str) or resource_id.lower() != expected_id.lower():
        raise SafeError("The container resource did not match the active subscription/group/name.")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="aci-dns-") as directory:
        base = export_group(args.resource_group, args.name, Path(directory) / "original.yaml", account)
        validate(base, args.name)
        current_label = base["properties"]["ipAddress"].get("dnsNameLabel")
        if current_label and current_label != args.dns_name_label:
            raise SafeError("This group already has a different DNS label. Use its current FQDN; this helper will not replace an existing hostname.")
        if current_label == args.dns_name_label:
            print("The requested DNS label is already configured; no redeployment is needed.")
            print_hostname(args, account)
            return
        print("Target: " + args.resource_group + "/" + args.name)
        for container in base["properties"]["containers"]:
            props = container["properties"]
            requests = props["resources"]["requests"]
            print(f"Preserving image {props['image']}, CPU {requests['cpu']}, memory {requests['memoryInGB']} GB")
        print("Preserving restart policy: " + base["properties"].get("restartPolicy", "Always"))
        print("DNS label: " + args.dns_name_label)
        print("Applying this change restarts the container group and may change its IP address.")
        if not args.apply:
            print("Read-only preview complete. No registry credential lookup or deployment was performed. Run again with --apply to update.")
            return
        proposed = copy.deepcopy(base)
        proposed["properties"]["ipAddress"]["dnsNameLabel"] = args.dns_name_label
        restore_registry_passwords(proposed, args.use_existing_acr_admin, account)
        latest = export_group(args.resource_group, args.name, Path(directory) / "latest.yaml", account)
        if latest != base:
            raise SafeError("Container settings changed during preparation. Nothing was deployed; run the preview again.")
        payload = Path(directory) / "update.json"
        payload.write_text(json.dumps(proposed))
        payload.chmod(0o600)
        az("container", "create", "--resource-group", args.resource_group, "--name", args.name, "--file", str(payload), "--subscription", account, "--output", "none")
        print_hostname(args, account)


if __name__ == "__main__":
    try:
        main()
    except SafeError as error:
        print("Stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Interrupted. Check Azure Portal if deployment had started.", file=sys.stderr)
        sys.exit(130)
    except Exception:
        print("Stopped after an unexpected error. No credentials or raw Azure response were printed. Check Azure Portal if deployment had started.", file=sys.stderr)
        sys.exit(1)
