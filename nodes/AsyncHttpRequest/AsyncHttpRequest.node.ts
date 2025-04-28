import {
    IExecuteFunctions,
    INodeType,
    INodeTypeDescription,
    INodeExecutionData,
    NodeOperationError,
    IHttpRequestOptions, // Correct type
    IHttpRequestMethods,
    IDataObject,
    NodeApiError,
    IWebhookFunctions, // Correct type for webhook context
    INodeCredentials, // Needed for requestWithAuthentication helper signature
    // NodeConnectionType,
    // INodePropertyOptions,
} from 'n8n-workflow';

// Removed: import { OptionsWithUri } from 'request-promise-native';
// Removed: import { URL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import * as objectPath from 'object-path';

// Define an interface for the webhook configuration parameters
interface IWebhookConfig {
    webhookMethod?: 'POST' | 'GET' | 'PUT';
    correlationIdLocationInRequest?: 'query' | 'header' | 'bodyJsonPath' | 'none';
    correlationIdParameterName?: string;
    callbackUrlParameterNameInRequest?: string;
    callbackUrlLocationInRequest?: 'query' | 'header' | 'bodyJsonPath';
    correlationIdLocationInWebhook?: 'query' | 'header' | 'bodyJsonPath';
    correlationIdParameterNameInWebhook?: string;
    timeoutWebhook?: number;
    webhookResponseIncludes?: Array<'body' | 'headers' | 'query'>;
}

// Interface for the structure stored in static data for listeners
interface IWebhookListener {
    resolve: (data: IDataObject) => void;
    reject: (reason?: any) => void;
    timeoutTimer: NodeJS.Timeout;
    expectedMethod: string;
    correlationId: string; // The unique value expected
    webhookConfig: IWebhookConfig;
    itemIndex: number;
    // Removed nodeInstance, not reliable here
}

// Define structure returned by this.getRequestObject() for clarity (subset)
interface IWebhookRequestObject {
    headers: IDataObject;
    params: IDataObject; // URL path parameters
    query: IDataObject;
    body: IDataObject | string | undefined;
    method?: string;
    path?: string;
}


export class AsyncHttpRequest implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Async HTTP Request',
        name: 'asyncHttpRequest',
        icon: 'fa:exchange-alt',
        group: ['helpers'],
        version: 1,
        description: 'Sends an HTTP request and optionally waits for a correlated asynchronous response via webhook.',
        defaults: {
            name: 'Async HTTP Request',
        },
        inputs: ['main'],
        outputs: ['main'],
        credentials: [
            // Credentials definitions remain the same...
             {
                 name: 'httpBasicAuth',
                 required: false,
                 displayOptions: { show: { authentication: ['basicAuth'] } },
             },
             {
                 name: 'httpDigestAuth',
                 required: false,
                 displayOptions: { show: { authentication: ['digestAuth'] } },
             },
             {
                 name: 'httpHeaderAuth',
                 required: false,
                 displayOptions: { show: { authentication: ['headerAuth'] } },
             },
             {
                 name: 'httpOAuth1Api',
                 required: false,
                 displayOptions: { show: { authentication: ['oAuth1'] } },
             },
             {
                 name: 'httpOAuth2Api',
                 required: false,
                 displayOptions: { show: { authentication: ['oAuth2'] } },
             },
             {
                 name: 'queryAuthApi',
                 required: false,
                 displayOptions: { show: { authentication: ['queryAuth'] } },
             },
        ],
        properties: [
            // Standard HTTP Request properties remain the same...
             {
                 displayName: 'URL',
                 name: 'url',
                 type: 'string',
                 required: true,
                 default: '',
                 placeholder: 'http://example.com/resource',
                 description: 'The URL to send the request to',
             },
             {
                 displayName: 'Method',
                 name: 'method',
                 type: 'options',
                 options: [
                     { name: 'DELETE', value: 'DELETE' },
                     { name: 'GET', value: 'GET' },
                     { name: 'HEAD', value: 'HEAD' },
                     { name: 'OPTIONS', value: 'OPTIONS' },
                     { name: 'PATCH', value: 'PATCH' },
                     { name: 'POST', value: 'POST' },
                     { name: 'PUT', value: 'PUT' },
                 ],
                 required: true,
                 default: 'GET',
                 description: 'The HTTP method to use for the request',
             },
             {
                 displayName: 'Authentication',
                 name: 'authentication',
                 type: 'options',
                 options: [
                     { name: 'None', value: 'none' },
                     { name: 'Basic Auth', value: 'basicAuth' },
                     { name: 'Digest Auth', value: 'digestAuth' },
                     { name: 'Header Auth', value: 'headerAuth' },
                     { name: 'OAuth1', value: 'oAuth1' },
                     { name: 'OAuth2', value: 'oAuth2' },
                     { name: 'Query Auth', value: 'queryAuth'},
                 ],
                 default: 'none',
                 description: 'The authentication method to use',
             },
             {
                 displayName: 'Send Body',
                 name: 'sendBody',
                 type: 'boolean',
                 default: false,
                 description: 'Whether to send a body with the request',
                 displayOptions: { show: { method: ['PATCH', 'POST', 'PUT'] } },
             },
             {
                 displayName: 'Body Content Type',
                 name: 'contentType',
                 type: 'options',
                 displayOptions: { show: { sendBody: [true], method: ['PATCH', 'POST', 'PUT'] } },
                 options: [
                     { name: 'Form-Data Multipart', value: 'multipart-form-data' },
                     { name: 'Form-URL-Encoded', value: 'form-urlencoded' },
                     { name: 'JSON', value: 'json' },
                     { name: 'Raw', value: 'raw' },
                     { name: 'N/A', value: 'none' }
                 ],
                 required: true,
                 default: 'json',
                 description: 'The Content-Type to send with the request body',
             },
             {
                 displayName: 'Raw Content Type',
                 name: 'rawContentType',
                 type: 'string',
                 default: 'text/plain',
                 required: true,
                 displayOptions: {
                     show: {
                         sendBody: [true],
                         contentType: ['raw'],
                         method: ['PATCH', 'POST', 'PUT'],
                     },
                 },
                 description: 'Content-Type header value for Raw body type',
             },
             {
                 displayName: 'Specify Body',
                 name: 'specifyBody',
                 type: 'options',
                 displayOptions: { show: { sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['json', 'raw', 'form-urlencoded'] } },
                 options: [
                     { name: 'Using Fields Below', value: 'keypair' },
                     // Corrected displayOptions within options
                     { name: 'Using JSON', value: 'json', displayOptions: { show: { '/contentType': ['json'] } } },
                     { name: 'Using Raw Body', value: 'raw', displayOptions: { show: { '/contentType': ['raw'] } } },
                 ],
                 default: 'keypair',
                 description: 'How to specify the body content',
             },
             {
                 displayName: 'Body Parameters',
                 name: 'bodyParameters',
                 type: 'fixedCollection',
                 displayOptions: { show: { specifyBody: ['keypair'], sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['form-urlencoded', 'json'] } },
                 typeOptions: { multipleValues: true },
                 placeholder: 'Add Parameter',
                 default: { values: [{ name: '', value: '' }] },
                 // Corrected default structure to match type 'fixedCollection' with multipleValues
                 options: [ { name: 'values', displayName: 'Parameter', values: [ { displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' } ] } ],
             },
             {
                 displayName: 'JSON',
                 name: 'jsonBody',
                 type: 'json',
                 displayOptions: { show: { specifyBody: ['json'], sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['json'] } },
                 default: '',
                 placeholder: '{ "key": "value" }',
                 required: true,
                 description: 'The JSON body to send',
             },
             {
                 displayName: 'Raw Body',
                 name: 'rawBody',
                 type: 'string',
                 typeOptions: { rows: 4 },
                 displayOptions: { show: { specifyBody: ['raw'], sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['raw'] } },
                 default: '',
                 placeholder: 'Enter raw body data...',
                 required: true,
                 description: 'The raw body content',
             },
            // Multipart form-data section (Placeholder - requires specific implementation)
            {
                displayName: 'Send Form-Data',
                name: 'sendMultipart',
                type: 'boolean',
                default: false,
                description: 'Whether to send multipart form-data (Requires specifying fields)',
                displayOptions: { show: { sendBody: [true], method: ['POST', 'PUT', 'PATCH'], contentType: ['multipart-form-data'] } },
            },
            {
                displayName: 'Form-Data Parameters',
                name: 'multipartParameters',
                type: 'fixedCollection',
                displayOptions: { show: { sendBody: [true], method: ['POST', 'PUT', 'PATCH'], contentType: ['multipart-form-data'], sendMultipart: [true] } },
                typeOptions: { multipleValues: true },
                placeholder: 'Add Part',
                default: { values: [{ name: '', value: '', type: 'string' }] },
                description: 'Define the parts of the multipart request. Use expressions for binary data.',
                options: [
                    {
                        name: 'values',
                        displayName: 'Part',
                        values: [
                            { displayName: 'Name', name: 'name', type: 'string', default: '', description: 'Name of the form field' },
                            { displayName: 'Value', name: 'value', type: 'string', default: '', description: 'Value of the field. For files, use an expression resolving to binary data (e.g., {{$binary.data}}).'},
                            { displayName: 'Type', name: 'type', type: 'options', options: [{name: 'String', value: 'string'}, {name: 'Binary', value: 'binary'}], default: 'string', description: 'Specify if the value is a string or binary data.'},
                            { displayName: 'Content-Type', name: 'contentType', type: 'string', default: '', description: '(Optional) Specify Content-Type for this part, especially for binary data.'},
                            { displayName: 'Filename', name: 'filename', type: 'string', default: '', description: '(Optional) Specify filename for binary data.'},
                        ]
                    }
                ],
            },
             {
                 displayName: 'Send Query Parameters',
                 name: 'sendQuery',
                 type: 'boolean',
                 default: false,
                 description: 'Whether to send query parameters with the request',
             },
             {
                 displayName: 'Query Parameters',
                 name: 'queryParameters',
                 type: 'fixedCollection',
                 displayOptions: { show: { sendQuery: [true] } },
                 typeOptions: { multipleValues: true },
                 placeholder: 'Add Parameter',
                 default: { values: [{ name: '', value: '' }] },
                 options: [ { name: 'values', displayName: 'Parameter', values: [ { displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' } ] } ],
             },
             {
                 displayName: 'Send Headers',
                 name: 'sendHeaders',
                 type: 'boolean',
                 default: false,
                 description: 'Whether to send custom headers with the request',
             },
             {
                 displayName: 'Headers',
                 name: 'headerParameters',
                 type: 'fixedCollection',
                 displayOptions: { show: { sendHeaders: [true] } },
                 typeOptions: { multipleValues: true },
                 placeholder: 'Add Header',
                 default: { values: [{ name: '', value: '' }] },
                 options: [ { name: 'values', displayName: 'Header', values: [ { displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' } ] } ],
             },
             {
                 displayName: 'Options',
                 name: 'options',
                 type: 'collection',
                 placeholder: 'Add Option',
                 default: {},
                 options: [
                     { displayName: 'Batching', name: 'batching', type: 'boolean', default: false, description: 'Whether to enables batching. (Note: Batching with webhook wait is complex and may process items individually)' },
                     { displayName: 'Ignore Response Code', name: 'ignoreResponseCode', type: 'boolean', default: false, description: 'Whether to succeed even if the HTTP status code indicates an error' },
                     { displayName: 'Allow Unauthorized Certificates', name: 'allowUnauthorizedCerts', type: 'boolean', default: false, description: 'Whether to allow unauthorized certificates (e.g. self-signed)' },
                     { displayName: 'Timeout (ms)', name: 'timeout', type: 'number', typeOptions: { minValue: 1 }, default: 10000, description: 'Time in milliseconds to wait for the initial request to complete' },
                     { displayName: 'Proxy', name: 'proxy', type: 'string', default: '', placeholder: 'http://myproxy:3128', description: 'HTTP proxy to use for the request' },
                     { displayName: 'Response Format', name: 'responseFormat', type: 'options', options: [ { name: 'Autodetect', value: 'autodetect' }, { name: 'File', value: 'file' }, { name: 'JSON', value: 'json' }, { name: 'Text', value: 'text' } ], default: 'autodetect', description: 'How to format the response data' },
                     { displayName: 'Response Character Encoding', name: 'responseCharacterEncoding', type: 'options', displayOptions: { show: { responseFormat: ['text', 'json', 'autodetect'] } }, options: [ { name: 'Autodetect', value: 'autodetect' }, { name: 'ISO-8859-1', value: 'latin1'}, { name: 'UTF-8', value: 'utf8'} ], default: 'autodetect', description: 'Character encoding for text based response formats like JSON and Text.' },
                     { displayName: 'Full Response', name: 'fullResponse', type: 'boolean', default: false, description: 'Whether to return the full response object (including headers, status code) instead of just the body' },
                 ],
             },
             // Webhook Response properties
             {
                 displayName: 'Wait for Webhook Response',
                 name: 'waitForWebhookResponse',
                 type: 'boolean',
                 default: false,
                 description: 'Whether to wait for an asynchronous response via webhook instead of using the direct HTTP response',
             },
             {
                 displayName: 'Webhook Configuration',
                 name: 'webhookConfig',
                 type: 'collection',
                 placeholder: 'Configure Webhook Wait',
                 default: {},
                 displayOptions: { show: { waitForWebhookResponse: [true] } },
                 options: [
                     { displayName: 'Webhook Method', name: 'webhookMethod', type: 'options', options: [ { name: 'POST', value: 'POST' }, { name: 'GET', value: 'GET' }, { name: 'PUT', value: 'PUT' } ], default: 'POST', required: true, description: 'The HTTP method the external service will use to call the webhook' },
                     { displayName: 'Correlation ID Location (in Request)', name: 'correlationIdLocationInRequest', type: 'options', options: [ { name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' }, { name: 'Do Not Send', value: 'none' } ], default: 'none', description: 'Where to place the unique correlation ID in the initial outbound HTTP request (if needed by the API)' },
                     // Corrected displayOptions path syntax
                     { displayName: 'Correlation ID Parameter Name (in Request)', name: 'correlationIdParameterName', type: 'string', default: 'correlationId', required: true, displayOptions: { show: { './correlationIdLocationInRequest': ['query', 'header', 'bodyJsonPath'] } }, description: 'Name of the query parameter, header, or the JSON path (dot notation) for the correlation ID in the initial request' },
                     { displayName: 'Callback URL Parameter Name (in Request)', name: 'callbackUrlParameterNameInRequest', type: 'string', default: 'callbackUrl', required: true, description: 'Parameter name (query, header, or body JSON path) used to send the generated webhook callback URL in the initial request' },
                     { displayName: 'Callback URL Location (in Request)', name: 'callbackUrlLocationInRequest', type: 'options', options: [ { name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' } ], default: 'bodyJsonPath', description: 'Where to place the webhook callback URL in the initial outbound HTTP request' },
                     { displayName: 'Correlation ID Location (in Webhook)', name: 'correlationIdLocationInWebhook', type: 'options', options: [ { name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' } ], required: true, default: 'bodyJsonPath', description: 'Where to find the correlation ID in the incoming webhook data to match the request' },
                     { displayName: 'Correlation ID Parameter Name (in Webhook)', name: 'correlationIdParameterNameInWebhook', type: 'string', default: 'correlationId', required: true, description: 'Name of the query parameter, header, or the JSON path (dot notation) for the correlation ID in the webhook response' },
                     { displayName: 'Webhook Timeout (seconds)', name: 'timeoutWebhook', type: 'number', typeOptions: { minValue: 1 }, default: 120, description: 'Maximum time (in seconds) to wait for the correct webhook response' },
                     { displayName: 'Webhook Response Includes', name: 'webhookResponseIncludes', type: 'multiOptions', options: [ { name: 'Body', value: 'body' }, { name: 'Headers', value: 'headers' }, { name: 'Query Parameters', value: 'query' } ], required: true, default: ['body'], description: 'Which parts of the incoming webhook request to include in the node output' },
                 ],
             },
        ],
        // --- Register Webhook ---
        webhooks: [
            {
                // 'default' is a standard n8n endpoint name
                // Use path parameters like ':webhookId' for dynamic routing
                name: 'default',
                httpMethod: '={{$parameter.webhookConfig.webhookMethod || "POST"}}', // Dynamic based on node parameter
                isFullPath: false, // Indicates the path is relative to the n8n webhook base URL
                path: 'webhook/:webhookId', // Route to capture the unique ID
                responseCode: '200', // Default response if not handled otherwise by the method
                // Note: Can't directly set responseMode to 'raw' easily here,
                // the webhook method itself will handle the response using this.sendResponse()
            },
        ],
        // Optional: Specify all possible methods if webhookMethod is dynamic
        // This helps n8n register routes correctly at startup.
        // If not dynamic, just list the single method used.
        webhookMethods: ['POST', 'GET', 'PUT'],
    };

    /**
     * Centralized static method to handle correlation ID injection/extraction.
     * @param location Where the ID is located (query, header, bodyJsonPath, none)
     * @param paramName The name of the parameter/header or the JSON path
     * @param data The object to modify (request options) or read from (webhook request object)
     * @param valueToSet The value to inject (correlation ID or callback URL)
     * @param isWebhookRequest Flag indicating if we are reading from a webhook request
     * @param node For logging/error context (optional, best effort)
     * @returns The extracted value (string | undefined) or void if injecting
     * @throws NodeOperationError if path access fails
     */
    private static handleCorrelationData(
        location: 'query' | 'header' | 'bodyJsonPath' | 'none',
        paramName: string,
        data: IHttpRequestOptions | IWebhookRequestObject, // Union type for flexibility
        valueToSet?: string, // Only provided when injecting
        isWebhookRequest: boolean = false,
        node?: INodeType, // Pass node for better error context if possible
    ): string | undefined | void {
        try {
            if (location === 'none') {
                return valueToSet !== undefined ? undefined : undefined; // Inject nothing, extract nothing
            }

            if (isWebhookRequest) {
                 // --- Extracting from Webhook Request Object ---
                const reqObject = data as IWebhookRequestObject;
                if (location === 'query') {
                    return reqObject.query?.[paramName] as string | undefined;
                } else if (location === 'header') {
                    const lowerCaseParamName = paramName.toLowerCase();
                    const headers = reqObject.headers;
                    if (!headers) return undefined;
                    const foundKey = Object.keys(headers).find(key => key.toLowerCase() === lowerCaseParamName);
                    return foundKey ? headers[foundKey] as string : undefined;
                } else if (location === 'bodyJsonPath') {
                    let body = reqObject.body;
                     // Attempt to parse if string (common for webhook bodies)
                    if (typeof body === 'string') {
                        try {
                            body = JSON.parse(body);
                        } catch (e) {
                            // Ignore parsing error, treat as non-object body for path extraction
                             console.warn(`Webhook body is not valid JSON, cannot extract path "${paramName}".`);
                            body = undefined;
                        }
                    }
                    if (typeof body === 'object' && body !== null) {
                        return objectPath.get(body, paramName) as string | undefined;
                    }
                    return undefined; // Cannot get path from non-object body
                }
            } else {
                 // --- Injecting into HTTP Request Options ---
                const requestOptions = data as IHttpRequestOptions;
                 if (valueToSet === undefined) return; // Nothing to inject

                if (location === 'query') {
                    requestOptions.qs = requestOptions.qs ?? {};
                    (requestOptions.qs as IDataObject)[paramName] = valueToSet;
                } else if (location === 'header') {
                    requestOptions.headers = requestOptions.headers ?? {};
                    (requestOptions.headers as IDataObject)[paramName] = valueToSet;
                } else if (location === 'bodyJsonPath') {
                    let currentBody = requestOptions.body;
                    let bodyIsObject = typeof currentBody === 'object' && currentBody !== null;

                    // Attempt to parse if string and content-type suggests JSON
                    if (typeof currentBody === 'string' && requestOptions?.headers?.['content-type']?.includes('json')) {
                        try {
                            currentBody = JSON.parse(currentBody);
                            bodyIsObject = true;
                        } catch (e) {
                             console.warn(`Could not parse existing string body as JSON for path injection. Initializing new object.`);
                            bodyIsObject = false; // Treat as non-object if parsing fails
                        }
                    }

                    // Initialize body as object if needed for path setting
                    if (!bodyIsObject) {
                        currentBody = {};
                    }

                    objectPath.set(currentBody as IDataObject, paramName, valueToSet);
                    requestOptions.body = currentBody; // Re-assign potentially modified/initialized body

                     // If the original body was stringified JSON, re-stringify after modification?
                     // This requires careful handling. If requestOptions.json = true, request lib handles it.
                     // If requestOptions.json = false, and it WAS stringified JSON, we need to re-stringify.
                     if (requestOptions.json !== true && typeof requestOptions.body === 'object' && requestOptions?.headers?.['content-type']?.includes('json')) {
                         try {
                             requestOptions.body = JSON.stringify(requestOptions.body);
                         } catch(e) {
                             throw new NodeOperationError(node || {} as INodeType, `Failed to re-stringify JSON body after injection: ${e.message}`, {});
                         }
                     }
                }
            }
        } catch (error: any) {
            // Use optional node context if available
            const contextNode = node || {} as INodeType;
            throw new NodeOperationError(contextNode, `Error ${valueToSet ? 'injecting into' : 'extracting from'} path "${paramName}" in ${isWebhookRequest ? 'webhook' : 'request'} data for location "${location}": ${error.message}`, { itemIndex: isWebhookRequest ? undefined : 0 });
        }
    }

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const items = this.getInputData();
        const returnData: INodeExecutionData[] = [];
        const fullResponseGlobal = this.getNodeParameter('options.fullResponse', 0, false) as boolean;
        const batchingGlobal = this.getNodeParameter('options.batching', 0, false) as boolean;
        const waitForWebhookResponseGlobal = this.getNodeParameter('waitForWebhookResponse', 0, false) as boolean;

        // Get static data storage for this node in this execution
        // Using 'listeners' as the key within the node's static data.
        const webhookListeners = this.getWorkflowStaticData('node').listeners as { [key: string]: IWebhookListener } || {};
        this.getWorkflowStaticData('node').listeners = webhookListeners; // Ensure it's initialized


        if (batchingGlobal && items.length > 1 && waitForWebhookResponseGlobal) {
            // Proper batching + webhook wait is very complex. Warn and process individually.
            this.logger.warn("Batching is enabled with 'Wait for Webhook Response'. Each item will be processed individually as batching webhook waits is not fully supported.");
        } else if (batchingGlobal && items.length > 1) {
             // Handle standard batching (no webhook wait) if needed - simplified here
             this.logger.warn("Batching is enabled but not fully implemented in this custom node example for standard requests. Each item will be processed individually.");
        }


        // Process each item individually
        for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
            // Per-item parameters
            const waitForWebhookResponse = this.getNodeParameter('waitForWebhookResponse', itemIndex, false) as boolean;
            const webhookConfig = this.getNodeParameter('webhookConfig', itemIndex, {}) as IWebhookConfig;
            const authentication = this.getNodeParameter('authentication', itemIndex, 'none') as string;
            const method = this.getNodeParameter('method', itemIndex, 'GET') as IHttpRequestMethods;
            const url = this.getNodeParameter('url', itemIndex, '') as string;
            const sendBody = this.getNodeParameter('sendBody', itemIndex, false) as boolean;
            const contentType = this.getNodeParameter('contentType', itemIndex, 'json') as string;
            const rawContentType = this.getNodeParameter('rawContentType', itemIndex, 'text/plain') as string;
            const specifyBody = this.getNodeParameter('specifyBody', itemIndex, 'keypair') as string;
            const sendMultipart = this.getNodeParameter('sendMultipart', itemIndex, false) as boolean;
            const sendQuery = this.getNodeParameter('sendQuery', itemIndex, false) as boolean;
            const sendHeaders = this.getNodeParameter('sendHeaders', itemIndex, false) as boolean;
            const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
            const fullResponse = this.getNodeParameter('options.fullResponse', itemIndex, fullResponseGlobal) as boolean;


            try {
                // Base Request Options
                const requestOptions: IHttpRequestOptions = {
                    method,
                    uri: url,
                    gzip: true,
                    rejectUnauthorized: !(options.allowUnauthorizedCerts as boolean | undefined ?? false),
                    timeout: (options.timeout as number | undefined) ?? 10000,
                    proxy: options.proxy as string | undefined,
                    // Encoding: null tells request to return Buffer for binary/autodetect
                    encoding: options.responseCharacterEncoding === 'autodetect' || options.responseCharacterEncoding === undefined ? null : options.responseCharacterEncoding as BufferEncoding | null,
                    headers: {},
                    qs: {},
                    // Always resolve with full response internally to access headers/status
                    resolveWithFullResponse: true,
                    // Set json = true *only* if content-type is json and we are sending an object
                    json: false, // Default to false, set below if needed
                };

                // --- Headers ---
                if (sendHeaders) {
                    const headerParameters = this.getNodeParameter('headerParameters.values', itemIndex, []) as Array<{name?: string, value?: string}>;
                    requestOptions.headers = headerParameters.reduce((acc, param) => {
                        if (param.name) acc[param.name] = param.value ?? '';
                        return acc;
                    }, requestOptions.headers as IDataObject);
                }

                // --- Query Parameters ---
                if (sendQuery) {
                    const queryParameters = this.getNodeParameter('queryParameters.values', itemIndex, []) as Array<{name?: string, value?: string}>;
                    requestOptions.qs = queryParameters.reduce((acc, param) => {
                        if (param.name) acc[param.name] = param.value ?? '';
                        return acc;
                    }, requestOptions.qs as IDataObject);
                }

                // --- Body ---
                if (sendBody && ['POST', 'PATCH', 'PUT'].includes(method)) {
                    requestOptions.headers = requestOptions.headers ?? {}; // Ensure headers object exists

                    if (contentType === 'json') {
                        requestOptions.headers['content-type'] = 'application/json; charset=utf-8';
                        if (specifyBody === 'keypair') {
                            const bodyParameters = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{name?: string, value?: any}>;
                            requestOptions.body = bodyParameters.reduce((acc, param) => {
                                if (param.name) acc[param.name] = param.value; // Keep original types if possible
                                return acc;
                            }, {} as IDataObject);
                        } else if (specifyBody === 'json') {
                            const jsonBodyStr = this.getNodeParameter('jsonBody', itemIndex, '{}') as string;
                            try {
                                requestOptions.body = JSON.parse(jsonBodyStr);
                            } catch (e: any) {
                                throw new NodeOperationError(this.getNode(), `Invalid JSON in body: ${e.message}`, { itemIndex });
                            }
                        }
                        // Let request library handle stringification for objects
                        if (typeof requestOptions.body === 'object' && requestOptions.body !== null) {
                             requestOptions.json = true;
                        } else {
                             // If body is already a string (e.g., from jsonBody field being a string literal like '"abc"'), send as is.
                             requestOptions.json = false;
                        }
                    } else if (contentType === 'form-urlencoded') {
                        requestOptions.headers['content-type'] = 'application/x-www-form-urlencoded';
                        if (specifyBody === 'keypair') {
                            const bodyParameters = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{name?: string, value?: string}>;
                            requestOptions.form = bodyParameters.reduce((acc, param) => {
                                if (param.name) acc[param.name] = param.value ?? '';
                                return acc;
                            }, {} as IDataObject);
                        } else {
                            throw new NodeOperationError(this.getNode(), 'For form-urlencoded, please use "Using Fields Below" to specify body.', { itemIndex });
                        }
                    } else if (contentType === 'multipart-form-data') {
                         if (sendMultipart) {
                             const multipartParameters = this.getNodeParameter('multipartParameters.values', itemIndex, []) as Array<{name?: string, value?: any, type?: string, contentType?: string, filename?: string}>;
                             requestOptions.formData = {};
                             for (const part of multipartParameters) {
                                 if (!part.name) continue;

                                 let value = part.value;
                                 if (part.type === 'binary') {
                                     // Assuming 'value' is an expression resolving to { data: 'base64...', mimeType: '...', fileName: '...' } or similar binary structure
                                     // The helper function will extract the buffer
                                     const binaryData = this.helpers.assertBinaryData(itemIndex, value, part.name);
                                     const partOptions: any = {}; // Explicit any for options flexibility
                                     if (part.contentType) partOptions.contentType = part.contentType;
                                     if (part.filename || binaryData.fileName) partOptions.filename = part.filename || binaryData.fileName;
                                     if (binaryData.mimeType && !partOptions.contentType) partOptions.contentType = binaryData.mimeType;

                                     // Use Buffer directly with options
                                     value = {
                                         value: Buffer.from(binaryData.data, 'base64'),
                                         options: partOptions
                                     };
                                 }

                                 requestOptions.formData[part.name] = value;
                             }
                             // Content-Type header is usually set automatically by the request library for formData
                             delete requestOptions.headers['content-type'];
                         } else {
                            throw new NodeOperationError(this.getNode(), 'For multipart/form-data, enable "Send Form-Data" and specify parts.', { itemIndex });
                        }
                    } else if (contentType === 'raw') {
                        requestOptions.headers['content-type'] = rawContentType;
                        requestOptions.body = this.getNodeParameter('rawBody', itemIndex, '') as string;
                        requestOptions.json = false;
                    } else if (contentType === 'none') {
                        delete requestOptions.headers['content-type'];
                        delete requestOptions.body;
                    }
                }

                // --- Webhook Wait Logic ---
                if (waitForWebhookResponse) {
                    const correlationIdValue = uuidv4(); // The actual unique ID value
                    // Use a combination that is unique *per execution run* and *per item* within that run
                    // This is used as the key in our static data map and the URL path param
                    const webhookUniqueId = `${this.getExecutionId()}-${this.getNode().id}-${itemIndex}-${uuidv4().substring(0, 8)}`;

                    const {
                        webhookMethod = 'POST',
                        correlationIdLocationInRequest = 'none',
                        correlationIdParameterName = 'correlationId',
                        callbackUrlParameterNameInRequest = 'callbackUrl',
                        callbackUrlLocationInRequest = 'bodyJsonPath',
                        timeoutWebhook = 120,
                        // Other webhookConfig properties used in the webhook handler
                    } = webhookConfig;

                    // 1. Construct Webhook URL using the unique ID
                    // 'default' matches the name in description.webhooks
                    // Pass the ID as a parameter for the registered path 'webhook/:webhookId'
                    const webhookUrl = this.getNodeWebhookUrl('default', { webhookId: webhookUniqueId });
                    if (!webhookUrl) {
                        throw new NodeOperationError(this.getNode(), 'Could not generate webhook URL. Ensure Instance Base URL is configured correctly in n8n settings.', { itemIndex });
                    }

                    // 2. Inject Correlation ID into the request
                    AsyncHttpRequest.handleCorrelationData(
                        correlationIdLocationInRequest,
                        correlationIdParameterName as string,
                        requestOptions,
                        correlationIdValue, // Inject the generated UUID value
                        false, // isWebhookRequest = false
                        this.getNode() // Pass node for context
                    );

                    // 3. Inject Callback URL into the request
                    AsyncHttpRequest.handleCorrelationData(
                        callbackUrlLocationInRequest,
                        callbackUrlParameterNameInRequest as string,
                        requestOptions,
                        webhookUrl, // Inject the generated webhook URL
                        false, // isWebhookRequest = false
                        this.getNode() // Pass node for context
                    );


                    // 4. Define the Waiter Promise & Register Listener in Static Data
                    const waitPromise = new Promise<IDataObject>((resolve, reject) => {
                        const timeoutSeconds = (timeoutWebhook as number) * 1000;
                        const timer = setTimeout(() => {
                            // Check if the listener still exists before trying to remove/reject
                            if (webhookListeners[webhookUniqueId]) {
                                delete webhookListeners[webhookUniqueId]; // Remove listener from static data
                                reject(new NodeOperationError(this.getNode(), `Webhook wait timed out after ${timeoutWebhook} seconds for ID ${webhookUniqueId}`, { itemIndex }));
                            }
                        }, timeoutSeconds);

                        // Store the listener details in workflow static data
                        webhookListeners[webhookUniqueId] = {
                            resolve,
                            reject,
                            timeoutTimer: timer,
                            expectedMethod: (webhookMethod as string).toUpperCase(),
                            correlationId: correlationIdValue, // Store the expected value
                            webhookConfig: webhookConfig, // Store config for extraction logic
                            itemIndex: itemIndex
                            // Removed nodeInstance
                        };
                        this.logger.debug(`Webhook Listener Added: ${webhookUniqueId} for Correlation ID: ${correlationIdValue}`);
                    });

                    // 5. Send Initial HTTP Request (using Authentication Helper)
                    let initialResponse: any;
                    try {
                        this.logger.debug(`Sending initial request [${itemIndex}] for ${webhookUniqueId} (Correlation: ${correlationIdValue}): ${JSON.stringify(requestOptions)}`);

                        // Use helper that handles authentication automatically
                        initialResponse = await this.helpers.requestWithAuthentication(
                            authentication, // Credential type
                            requestOptions,
                            itemIndex // Pass itemIndex for credential lookup
                        );

                        this.logger.debug(`Initial request [${itemIndex}] sent successfully for ${webhookUniqueId}. Status: ${initialResponse?.statusCode}. Waiting for webhook...`);
                    } catch (error: any) {
                        // Cleanup listener immediately if initial request fails hard
                        const listenerData = webhookListeners[webhookUniqueId];
                        if (listenerData) {
                            clearTimeout(listenerData.timeoutTimer);
                            delete webhookListeners[webhookUniqueId];
                            this.logger.debug(`Webhook Listener Removed due to initial request error: ${webhookUniqueId}`);
                        }

                        // Handle ignoreResponseCode for the *initial* request
                        if (!(options.ignoreResponseCode as boolean) || !(error instanceof NodeApiError)) {
                            throw error; // Re-throw critical errors or if not ignoring
                        } else {
                            // Log the error but continue to wait for webhook if ignoring response code
                            this.logger.warn(`Initial HTTP request [${itemIndex}] failed but ignoring response code. Error: ${error.message}. Status Code: ${error.context?.statusCode}. Proceeding to wait for webhook ${webhookUniqueId}.`);
                            // Optionally store the initial error details if needed later
                            // initialResponse = { error: error.message, statusCode: error.context?.statusCode, ... };
                        }
                    }

                    // 6. Wait for the correct webhook
                    this.logger.debug(`Waiting for webhook ${webhookUniqueId}...`);
                    const webhookResult = await waitPromise;

                    // 7. Prepare output data from webhook
                    returnData.push({ json: webhookResult, pairedItem: { item: itemIndex } });

                } else {
                    // --- Standard HTTP Request Execution (No Webhook Wait) ---
                    let response: any; // Will contain the full response object
                    try {
                        // Use helper that handles authentication automatically
                        response = await this.helpers.requestWithAuthentication(
                             authentication,
                             requestOptions, // Ensure resolveWithFullResponse is true internally
                             itemIndex
                        );

                        let responseData: any = response.body; // Start with the body

                        // Handle non-full response formatting (if requested)
                        if (!fullResponse) {
                            if (options.responseFormat === 'file') {
                                // Handle binary data
                                if (!Buffer.isBuffer(response.body)) {
                                     // Try converting if it looks like base64 or similar? Or just error.
                                    throw new NodeOperationError(this.getNode(), 'Response body is not a Buffer, cannot format as file.', { itemIndex });
                                }
                                const mimeType = response.headers['content-type']?.split(';')[0] || 'application/octet-stream';

                                // Use helpers for binary data
                                const binaryData = await this.helpers.prepareBinaryData(response.body, undefined, mimeType);

                                // Structure for binary output
                                returnData.push({ json: {}, binary: { data: binaryData }, pairedItem: { item: itemIndex } });
                                continue; // Skip standard returnData.push below for binary

                            } else if (options.responseFormat === 'text') {
                                // Ensure it's text
                                responseData = Buffer.isBuffer(response.body) ? response.body.toString(requestOptions.encoding || undefined) : (typeof response.body === 'object' ? JSON.stringify(response.body) : String(response.body));
                            } else if (options.responseFormat === 'json' || (options.responseFormat === 'autodetect' && typeof response.body === 'object')) {
                                // Try to parse if not already an object (request lib might parse automatically if json:true was set)
                                // If responseFormat is 'json', force parsing attempt.
                                if (typeof response.body === 'string') {
                                    try {
                                        responseData = JSON.parse(response.body);
                                    } catch (e: any) {
                                        if (options.responseFormat === 'json') { // Only error if explicitly JSON requested
                                            throw new NodeOperationError(this.getNode(), `Response body is not valid JSON: ${e.message}`, { itemIndex, cause: e });
                                        }
                                        // Otherwise (autodetect string), keep as string
                                        responseData = response.body;
                                    }
                                } else if (Buffer.isBuffer(response.body)) {
                                    try {
                                        responseData = JSON.parse(response.body.toString(requestOptions.encoding || undefined));
                                    } catch (e: any) {
                                        if (options.responseFormat === 'json') { // Only error if explicitly JSON requested
                                            throw new NodeOperationError(this.getNode(), `Response body buffer is not valid JSON: ${e.message}`, { itemIndex, cause: e });
                                        }
                                        // Otherwise (autodetect buffer), convert to string
                                        responseData = response.body.toString(requestOptions.encoding || undefined);
                                    }
                                }
                                // If already object (e.g. from json:true or autodetect), use as is
                                else if (typeof response.body === 'object') {
                                    responseData = response.body;
                                }
                            } else {
                                // Autodetect fallback for string/buffer -> treat as text
                                responseData = Buffer.isBuffer(response.body) ? response.body.toString(requestOptions.encoding || undefined) : String(response.body);
                            }
                        } else {
                            // Full response requested - structure it
                             let processedBody = response.body;
                             // Decode buffer for full response text/json view if applicable
                             if (Buffer.isBuffer(processedBody)) {
                                 if (options.responseFormat === 'text' || options.responseFormat === 'json' || options.responseFormat === 'autodetect') {
                                      // Attempt to decode based on detected/specified encoding for display
                                      try {
                                           processedBody = processedBody.toString(requestOptions.encoding || undefined);
                                           if (options.responseFormat === 'json' || (options.responseFormat === 'autodetect' && response.headers['content-type']?.includes('json'))) {
                                                processedBody = JSON.parse(processedBody);
                                           }
                                      } catch(e) {
                                          this.logger.warn(`Could not decode/parse buffer body for full response preview: ${e}`);
                                          // Keep buffer reference? Or base64 string? Keep decoded string for now.
                                      }
                                 } else {
                                     // For 'file' or unknown in full response, maybe show base64?
                                     // processedBody = response.body.toString('base64'); // Alternative
                                     processedBody = `Buffer data (length: ${response.body.length})`; // Placeholder
                                 }
                             } else if (typeof processedBody === 'object' && options.responseFormat !== 'json') {
                                 // Stringify object body if response format wasn't JSON (e.g., autodetect -> text)
                                 processedBody = JSON.stringify(processedBody);
                             }


                            responseData = {
                                headers: response.headers,
                                body: processedBody, // Show potentially decoded/parsed/stringified body
                                statusCode: response.statusCode,
                                statusMessage: response.statusMessage,
                            };
                        }

                        returnData.push({ json: responseData, pairedItem: { item: itemIndex } });

                    } catch (error: any) {
                        if (!(options.ignoreResponseCode as boolean) || !(error instanceof NodeApiError)) {
                            throw error; // Re-throw if not ignoring or not an API error
                        }

                        // If ignoring response code, return the error details
                        const errorContext = (error as NodeApiError).context ?? {};
                        const returnErrorData: IDataObject = {
                            error: {
                                message: error.message,
                                stack: error.stack?.split('\n').map((line:string) => line.trim()),
                                context: errorContext, // Include full context
                            }
                        };
                        // Simpler top-level structure mirroring full response
                        // returnErrorData.statusCode = errorContext.statusCode;
                        // returnErrorData.headers = errorContext.headers;
                        // returnErrorData.body = errorContext.body; // Include body from error if available

                        returnData.push({ json: returnErrorData, pairedItem: { item: itemIndex } });
                    }
                }

            } catch (error: any) {
                 // Handle errors thrown during item processing (including initial request errors not ignored)
                if (this.continueOnFail(itemIndex)) {
                    const errorData: IDataObject = { error: { message: error.message } };
                     if (error.stack) errorData.error.stack = error.stack.split('\n').map((line:string) => line.trim());
                    if (error instanceof NodeApiError && error.context) errorData.error.context = error.context;
                    else if (error.context) errorData.error.context = error.context; // Catch context from NodeOperationError

                    returnData.push({ json: errorData, pairedItem: { item: itemIndex } });
                    continue;
                }
                // If not continuing on fail, enhance the error with node context before throwing
                if (error instanceof NodeOperationError) throw error; // Don't re-wrap NodeOperationErrors
                throw new NodeOperationError(this.getNode(), error, { itemIndex });
            }
        }

        return [returnData];
    }

    /**
     * Static webhook handler registered in the node description.
     * This method is called by n8n's core webhook processor.
     * 'this' context is IWebhookFunctions.
     */
    static async webhook(this: IWebhookFunctions): Promise<void> {
        const req = this.getRequestObject();
        const node = this.getNode(); // Get node context for logging/errors

        // Extract the unique webhook ID from the request path parameter (:webhookId)
        const webhookUniqueId = req.params?.webhookId as string | undefined;

        if (!webhookUniqueId) {
             this.logger.warn(`Webhook received without a webhookId in path parameters.`);
            // Respond with 400 Bad Request
             this.sendResponse(400, { error: 'Missing webhook identifier in URL path.' });
            return;
        }

        this.logger.debug(`Webhook received for ID: ${webhookUniqueId}`);

        // Retrieve the listener map from static data for this execution
        const webhookListeners = this.getWorkflowStaticData('node').listeners as { [key: string]: IWebhookListener } || {};
        const listenerData = webhookListeners[webhookUniqueId];

        if (listenerData) {
            const { resolve, reject, timeoutTimer, expectedMethod, correlationId, webhookConfig, itemIndex } = listenerData;

            // Check HTTP Method
            const receivedMethod = (req.method ?? '').toUpperCase();
            if (receivedMethod !== expectedMethod) {
                this.logger.warn(`Webhook ${webhookUniqueId}: Received method ${receivedMethod}, expected ${expectedMethod}. Ignoring.`);
                // Respond politely but do not resolve/reject the waiting promise
                this.sendResponse(405, { error: `Method ${receivedMethod} not allowed for this webhook.` });
                return;
            }

            try {
                // Extract correlation ID from the incoming webhook request using the static helper
                const receivedCorrelationId = AsyncHttpRequest.handleCorrelationData(
                    webhookConfig.correlationIdLocationInWebhook as any, // Cast needed for union type
                    webhookConfig.correlationIdParameterNameInWebhook as string,
                    req, // Pass the incoming webhook request object
                    undefined, // Not injecting
                    true, // Indicate it's a webhook request extraction
                    node // Pass node for error context
                ) as string | undefined;

                this.logger.debug(`Webhook ${webhookUniqueId}: Expecting CorrelationID ${correlationId}, Received ${receivedCorrelationId}`);

                // Validate correlation ID
                if (receivedCorrelationId === correlationId) {
                    clearTimeout(timeoutTimer); // Stop timeout timer
                    delete webhookListeners[webhookUniqueId]; // Remove listener from static data
                    this.logger.info(`Webhook ${webhookUniqueId}: Correlation ID match! Resolving promise.`);

                    // Construct response based on user selection
                    const webhookResult: IDataObject = {};
                    const includes = webhookConfig.webhookResponseIncludes || ['body']; // Default to body

                    if (includes.includes('body')) webhookResult.body = req.body;
                    if (includes.includes('headers')) webhookResult.headers = req.headers;
                    if (includes.includes('query')) webhookResult.query = req.query;

                    resolve(webhookResult); // Resolve the waiting promise in the execute method

                    // Acknowledge the webhook call successfully
                    this.sendResponse(200, { status: 'success', message: 'Webhook processed.' });

                } else {
                    // Correlation ID mismatch - log it but keep listening until timeout
                    this.logger.warn(`Webhook ${webhookUniqueId}: Correlation ID mismatch. Expected ${correlationId}, got ${receivedCorrelationId}. Ignoring webhook call.`);
                    // Respond that the specific call wasn't matched, but the endpoint is valid
                    this.sendResponse(400, { status: 'ignored', message: 'Correlation ID mismatch.' });
                }
            } catch (error: any) {
                // Error during webhook processing (e.g., accessing body path)
                this.logger.error(`Webhook ${webhookUniqueId}: Error processing incoming webhook: ${error.message}`);

                // Reject the waiting promise in the execute method
                clearTimeout(timeoutTimer);
                delete webhookListeners[webhookUniqueId];
                // Use NodeOperationError, passing the node obtained earlier
                reject(new NodeOperationError(node, `Error processing webhook ${webhookUniqueId}: ${error.message}`, { itemIndex }));

                // Respond with an error to the webhook caller
                this.sendResponse(500, { status: 'error', message: `Internal error processing webhook: ${error.message}` });
            }
        } else {
            // No active listener found for this ID (might be late, duplicate, wrong ID, or from a different execution)
            this.logger.warn(`Webhook received for unknown or inactive listener ID: ${webhookUniqueId}. Ignoring.`);
            // Respond with 404 Not Found or 410 Gone
            this.sendResponse(404, { status: 'error', message: 'Webhook ID not found or listener inactive.' });
        }
    }
}
