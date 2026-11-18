# Stable hostname for the Azure Container Instance

The existing service runs in Azure Container Instances (ACI), where a container group's public IP address can change after a restart or update. Use its Azure DNS hostname instead of storing the numeric IP in clients.

This repository includes `scripts/azure-set-dns.py` to add a DNS label to the existing group using its complete exported deployment. It previews the change by default. An explicit `--apply` updates and restarts the same container group; it does not delete the group or rebuild its image.

## What is preserved

| Setting | Behavior |
| --- | --- |
| Resource group and container group | The existing resource selected by your arguments |
| Image | The image already running in the group |
| CPU and memory | Existing resource requests |
| Restart policy | Existing policy |
| Ports and other exported settings | Preserved from the current deployment |
| DNS label | The new label supplied in your command |

The helper preserves the exported settings and prints the actual image, resource requests, and restart policy for review. Check that they match your intended deployment before applying. It refuses to replace a different DNS label that is already configured; use the existing group's FQDN in that case.

## Preview in Azure Cloud Shell

Open **Bash** in [Azure Cloud Shell](https://shell.azure.com/) under the subscription that contains the service. After this script is available on the repository's `main` branch, download it:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/malabbas/Playwright-Action-API/main/scripts/azure-set-dns.py \
  --output azure-set-dns.py

python3 azure-set-dns.py \
  --resource-group your-resource-group \
  --name your-container-group \
  --dns-name-label your-browser-service
```

If Python reports that PyYAML is missing, install it in Cloud Shell and run the preview again:

```bash
python3 -m pip install --user PyYAML==6.0.3
```

The preview reads and validates the container group's configuration. It does not deploy, restart the group, or look up registry passwords. It uses the active Azure subscription; if the group cannot be found, select the correct subscription before continuing. Do not post the full exported deployment or any credentials in chat.

## Apply with existing registry authentication

The private image registry requires pull credentials. Azure's export does not recover a saved registry password, so the helper restores it privately before submitting the update.

If the deployed registry username belongs to the ACR admin account **and admin access is already enabled**, use:

```bash
python3 azure-set-dns.py \
  --resource-group your-resource-group \
  --name your-container-group \
  --dns-name-label your-browser-service \
  --apply \
  --use-existing-acr-admin
```

This option checks existing admin access and verifies that the registry username matches the deployed username before deployment. It retrieves an existing password privately; it does not enable admin access, rotate credentials, or print the password or put it into command arguments.

If admin access is disabled, the usernames differ, or you need to use the original non-admin credential, run without that flag:

```bash
python3 azure-set-dns.py \
  --resource-group your-resource-group \
  --name your-container-group \
  --dns-name-label your-browser-service \
  --apply
```

Enter the **original durable registry password** at the hidden prompt in Cloud Shell. Do not paste it into chat or add it to the command. If you do not have that credential, stop and recover it from your original deployment's secret source. A temporary `az acr login --expose-token` token is not a durable replacement for future image pulls.

Applying restarts the group and briefly interrupts the service. The helper checks that the exported configuration has not changed during preparation and uses private temporary files for the complete update. It refuses unsupported secret-bearing configurations, including secure environment variables, secret or Azure Files volumes, Log Analytics settings, and extensions, rather than silently dropping their values. If a guard stops the process before submission, no deployment is made; use the original deployment definition and secret source for that configuration.

If Azure reports a failure or the operation is interrupted, inspect the resource's deployment/activity status in Azure Portal before retrying. A submitted update may still be running. The helper does not automatically delete, roll back, or recreate the group.

## Use the returned hostname

After a successful update, the helper prints the exact DNS hostname and a credential-free `/health` URL. You can also read the **FQDN** from the container group's **Overview** in Azure Portal. Copy the displayed hostname; Azure can include a generated hash, so do not construct it from the DNS label yourself.

The application route stays `/actions` on port `3000`. Changing DNS does not change the API path or install the code currently published on GitHub. The running image remains unchanged; deploying new source requires a separate image build and deployment.

Keep the same container group and DNS label for clients that need a consistent hostname. Deleting and creating a new group can produce a different FQDN depending on its DNS reuse policy.

## HTTPS is a separate step

A DNS name does not enable TLS. The current `http://...:3000` listener remains HTTP after this change. Use its `/health` endpoint without credentials for a connectivity check; do not send bearer tokens over plaintext HTTP or share it as an authenticated public demo.

Configure HTTPS before sending API credentials, for example with a TLS reverse proxy or a sidecar in the container group. That is a separate deployment change, not part of this DNS helper. Microsoft documents [automatic HTTPS with a Caddy sidecar](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-container-group-automatic-ssl).

References: [ACI update behavior and changing IP addresses](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-update), [finding the FQDN in Azure Portal](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-quickstart-portal), and [DNS name reuse policies](https://learn.microsoft.com/en-us/azure/container-instances/how-to-reuse-dns-names).
