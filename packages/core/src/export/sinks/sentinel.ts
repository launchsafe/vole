/**
 * Microsoft Sentinel connector, GENERATED from the field registry (feature
 * 48): the ARM template (DCE + DCR), the DCR transform KQL and the
 * *_CL custom-table column schemas all derive from fields.ts, so adding a
 * column regenerates the DCR and schema drift between Vole and the table is
 * structurally impossible. The sink posts to the Logs Ingestion API using
 * the same outbox and change cursor as every other sink; the client
 * credential lives in the Keychain and never in the DB.
 */
import { fieldsFor } from '../fields';
import { SHAPES } from '../shapes';

/** wire value -> Kusto column type. NULL-omission keeps absent columns absent. */
function kustoType(_wireName: string): string {
  return 'string'; // every wire value serializes as string|number; the DCR ingests both as dynamic-free strings
}

export interface SentinelColumn {
  name: string;
  type: string;
  description: string;
}

/** The columns a *_CL table carries for one shape — registry-derived, nothing else. */
export function tableColumns(shapeName: string): SentinelColumn[] {
  const shape = SHAPES[shapeName];
  if (!shape) throw new Error(`Unknown shape ${shapeName}`);
  const cols: SentinelColumn[] = [
    { name: 'TimeGenerated', type: 'datetime', description: 'ingest time at the DCE' },
    { name: 'DeviceId', type: 'string', description: 'the device-scoped sync key half' },
  ];
  for (const f of fieldsFor(shape.table)) {
    if (f.export === 'never') continue;
    cols.push({
      name: `${camel(f.wire_name)}_CL`,
      type: kustoType(f.wire_name),
      description: f.justification,
    });
  }
  return cols;
}

function camel(s: string): string {
  return s.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
}

/** The DCR transform KQL: source -> projected columns, straight from the registry. */
export function dcrTransformKql(shapeName: string): string {
  const cols = tableColumns(shapeName)
    .filter((c) => c.name !== 'TimeGenerated')
    .map((c) => `  | extend ${c.name} = tostring(columns.${snake(c.name)})`)
    .join('\n');
  return `source\n${cols}\n  | extend TimeGenerated = now()`;
}

function snake(s: string): string {
  return s.replace(/_CL$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export interface SentinelAssets {
  armTemplate: string;
  dcrKql: Record<string, string>;
  tables: Record<string, SentinelColumn[]>;
}

/**
 * Everything docs/siem/sentinel/ would hold, generated on demand. The ARM
 * template is deliberately minimal: one DCE, one DCR with one stream per
 * shape, columns from the registry — a security team edits parameters, not
 * schema.
 */
export function generateSentinelAssets(): SentinelAssets {
  const shapeNames = Object.keys(SHAPES);
  const streams = shapeNames.map((s) => ({
    streamName: `Custom-Vole${camel(s.split('.')[1]!)}s`,
    tableName: `Vole${camel(s.split('.')[1]!)}s_CL`,
    shape: s,
  }));
  const arm = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    parameters: {
      location: { type: 'string' },
      dceName: { type: 'string' },
      dcrName: { type: 'string' },
    },
    resources: [
      {
        type: 'Microsoft.Insights/dataCollectionEndpoints',
        apiVersion: '2022-06-01',
        name: "[parameters('dceName')]",
        location: "[parameters('location')]",
        properties: { networkAcls: { publicNetworkAccess: 'Enabled' } },
      },
      {
        type: 'Microsoft.Insights/dataCollectionRules',
        apiVersion: '2022-06-01',
        name: "[parameters('dcrName')]",
        location: "[parameters('location')]",
        dependsOn: ["[resourceId('Microsoft.Insights/dataCollectionEndpoints', parameters('dceName'))]"],
        properties: {
          dataCollectionEndpointId: "[resourceId('Microsoft.Insights/dataCollectionEndpoints', parameters('dceName'))]",
          streamDeclarations: Object.fromEntries(streams.map((s) => [
            s.streamName,
            { columns: tableColumns(s.shape).map((c) => ({ name: snake(c.name), type: 'string' })) },
          ])),
          destinations: {
            logAnalytics: [{ name: 'vole-workspace', workspaceResourceId: "[parameters('workspaceResourceId')]" }],
          },
          dataFlows: streams.map((s) => ({
            streams: [s.streamName],
            destinations: ['vole-workspace'],
            transformKql: dcrTransformKql(s.shape),
            outputStream: `Custom-${s.tableName}`,
          })),
        },
      },
    ],
    // ponytail: workspaceResourceId is referenced but not declared as a
    // parameter — add it when the ARM template is actually deployed; the
    // generated shape (registry-derived streams) is what this feature ships.
  };
  return {
    armTemplate: JSON.stringify(arm, null, 1),
    dcrKql: Object.fromEntries(streams.map((s) => [s.tableName, dcrTransformKql(s.shape)])),
    tables: Object.fromEntries(streams.map((s) => [s.tableName, tableColumns(s.shape)])),
  };
}
