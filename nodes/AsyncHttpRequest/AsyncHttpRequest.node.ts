import {
    IExecuteFunctions,
    INodeType,
    INodeTypeDescription,
    INodeExecutionData,
    NodeOperationError,
    IHttpRequestOptions,
    IHttpRequestMethods, // Keep this if used, otherwise remove
    IDataObject,
    NodeApiError,
    IWebhookFunctions,
    // INodeCredentials, // Removed as unused
    NodeConnectionType,
    INodeInputConfiguration,
    INodeOutputConfiguration,
    IAllExecuteFunctions, // For more precise helper 'this' types if needed
    BaseHelperFunctions, // Import base if needed for types explicitly
    BinaryHelperFunctions, // For binary helper types
    RequestHelperFunctions, // For request helper types
    NodeExecutionWithMetadata, // Used by getWorkflowStaticData
    Workflow, // Used by getWorkflowStaticData
    INode, // Required for NodeOperationError and helpers
    NodeParameterValue, // Type for parameters
    continueOnFail, // Import helper explicitly if needed
} from 'n8n-workflow';

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
    // Ensure this is treated as an array
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
}

// Define structure returned by this.getRequestObject() for clarity (subset)
interface IWebhookRequestObject {
    headers: IDataObject;
    params: IDataObject; // URL path parameters
    query: IDataObject;
    body: IDataObject | string | undefined | unknown; // Body can be unknown
    method?: string;
    path?: string;
}

// Type guard for NodeApiError
function isNodeApiError(error: any): error is NodeApiError {
  return error instanceof NodeApiError && typeof error.context === 'object';
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
        // Use standard array notation for inputs/outputs
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
            // Multipart form-data section
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
                 // Corrected default value structure
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
                 // Corrected default value structure
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
                     // Batching removed as it's complex with webhooks and might need specific execute logic
                     // { displayName: 'Batching', name: 'batching', type: 'boolean', default: false, description: 'Whether to enables batching. (Note: Batching with webhook wait is complex and may process items individually)' },
                     { displayName: 'Ignore Response Code', name: 'ignoreResponseCode', type: 'boolean', default: false, description: 'Whether to succeed even if the HTTP status code indicates an error' },
                     { displayName: 'Allow Unauthorized Certificates', name: 'allowUnauthorizedCerts', type: 'boolean', default: false, description: 'Whether to allow unauthorized certificates (e.g. self-signed)' },
                     { displayName: 'Timeout (ms)', name: 'timeout', type: 'number', typeOptions: { minValue: 1 }, default: 10000, description: 'Time in milliseconds to wait for the initial request to complete' },
                     { displayName: 'Proxy', name: 'proxy', type: 'string', default: '', placeholder: 'http://myproxy:3128', description: 'HTTP proxy to use for the request (e.g., http://user:pass@host:port)' },
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
                name: 'default', // Standard n8n endpoint name
                httpMethod: '={{$parameter.webhookConfig.webhookMethod || "POST"}}', // Dynamic based on node parameter
                isFullPath: false, // Relative to n8n webhook base URL
                path: 'webhook/:webhookId', // Route to capture the unique ID
                responseCode: '200', // Default success response handled by n8n core
                // responseMode: 'raw', // Might be needed if sending custom response, but removed sendResponse calls
            },
        ],
        // List all possible methods if dynamic
        webhookMethods: ['POST', 'GET', 'PUT'],
    };

     /**
      * Centralized static method to handle correlation ID injection/extraction.
      * @param location Where the ID is located (query, header, bodyJsonPath, none)
      * @param paramName The name of the parameter/header or the JSON path
      * @param data The object to modify (request options) or read from (webhook request object)
      * @param valueToSet The value to inject (correlation ID or callback URL), undefined if reading
      * @param isWebhookRequest Flag indicating if we are reading from a webhook request
      * @param node For error context (required)
      * @returns The extracted value (string | undefined = this.getNodeParameter('sendHeaders', itemIndex, false) as boolean;
             const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
             const fullResponseGlobal = this.getNodeParameter('options.fullResponse', 0, false) as boolean; // Global default

             const returnData: INodeExecutionData[] = [];
             const items = this.getInputData();
             let response: NodeExecutionWithMetadata; // Declare response variable

             // Get static data storage specific to this node instance in this workflow execution
             // This avoids conflicts between different nodes or parallel runs if possible
             // Note: Still not persistent across n8n restarts or multi-worker setups without external store
             const staticData = this.getWorkflowStaticData('node');
             if (!staticData.listeners) {
                 staticData.listeners = {};
             }
             const webhookListeners = staticData.listeners as { [key: string]: IWebhookListener };


             for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
                 const method = this.getNodeParameter('method', itemIndex, 'GET') as IHttpRequestMethods;
                 const url = this.getNodeParameter('url', itemIndex, '') as string;
                 const authentication = this.getNodeParameter('authentication', itemIndex, 'none') as string;
                 const sendBody = this.getNodeParameter('sendBody', itemIndex, false) as boolean;
                 const contentType = this.getNodeParameter('contentType', itemIndex, 'json') as string;
                 const specifyBody = this.getNodeParameter('specifyBody', itemIndex, 'keypair') as string;
                 const rawContentType = this.getNodeParameter('rawContentType', itemIndex, 'text/plain') as string;
                 const sendMultipart = this.getNodeParameter('sendMultipart', itemIndex, false) as boolean;
                 const sendQuery = this.getNodeParameter('sendQuery', itemIndex, false) as boolean;
                 const sendHeaders = this.getNodeParameter('sendHeaders', itemIndex, false) as boolean;
                 const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
                 const fullResponse = this.getNodeParameter('options.fullResponse', itemIndex, fullResponseGlobal) as boolean;
                 const waitForWebhookResponse = this.getNodeParameter('waitForWebhookResponse', itemIndex, false) as boolean;
                 const webhookConfig = this.getNodeParameter('webhookConfig', itemIndex, {}) as IWebhookConfig;


                 // Use try-catch block per item for potential continueOnFail behavior
                 try {
                     // --- Base Request Options ---
                     const requestOptions: IHttpRequestOptions = {
                         method,
                         uri: url, // Use uri instead of url for IHttpRequestOptions standard
                         gzip: true,
                         // Use node helper for this check
                         rejectUnauthorized: !this.getNodeParameter('options.allowUnauthorizedCerts', itemIndex, false) as boolean,
                         timeout: this.getNodeParameter('options.timeout', itemIndex, 10000) as number,
                         // Proxy needs to be a string, assuming helper handles format 'http://user:pass@host:port'
                         proxy: this.getNodeParameter('options.proxy', itemIndex, undefined) as string | undefined,
                         headers: {},
                         qs: {}, // For query parameters
                         // Determine responseType based on options.responseFormat
                         responseType: 'arraybuffer', // Default to arraybuffer for manual handling/binary check
                         // Always resolve with full response internally to access headers/status
                         // The helper function likely does this, but be explicit if needed
                         // resolveWithFullResponse: true,
                         // Body related properties (body, json, form, formData) are set below
                     };

                     // --- Set Response Type Based on Format Option ---
                     const responseFormat = this.getNodeParameter('options.responseFormat', itemIndex, 'autodetect') as string;
                     const responseCharacterEncoding = this.getNodeParameter('options.responseCharacterEncoding', itemIndex, 'autodetect') as string;

                     // Map response format to responseType expected by helpers
                     if (responseFormat === 'json') {
                         requestOptions.responseType = 'json';
                     } else if (responseFormat === 'text') {
                         requestOptions.responseType = 'text';
                     } else {
                         // autodetect or file -> get raw buffer first
                         requestOptions.responseType = 'arraybuffer';
                     }

                     // Set encoding if text-based response is expected
                     if (requestOptions.responseType === 'text' && responseCharacterEncoding !== 'autodetect') {
                          // Assuming encoding is still a valid option alongside responseType for text
                          requestOptions.encoding = responseCharacterEncoding as BufferEncoding;
                     } else if (requestOptions.responseType !== 'arraybuffer') {
                          // Default to utf8 for json/text if not specified otherwise? Check helper behavior.
                          // requestOptions.encoding = 'utf8';
                     }


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
                             let bodyData: any;
                             if (specifyBody === 'keypair') {
                                 const bodyParameters = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{name?: string, value?: any}>;
                                 bodyData = bodyParameters.reduce((acc, param) => {
                                     if (param.name) acc[param.name] = param.value;
                                     return acc;
                                 }, {} as IDataObject);
                             } else if (specifyBody === 'json') {
                                 const jsonBodyStr = this.getNodeParameter('jsonBody', itemIndex, '{}') as string;
                                 try {
                                     bodyData = JSON.parse(jsonBodyStr);
                                 } catch (e: any) {
                                     throw new NodeOperationError(this.getNode(), `Invalid JSON in body: ${e.message}`, { itemIndex });
                                 }
                             }
                             // Let request library handle stringification if needed (json: true often does this)
                             requestOptions.json = true; // Indicate JSON payload
                             requestOptions.body = bodyData;

                         } else if (contentType === 'form-urlencoded') {
                             requestOptions.headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
                             if (specifyBody === 'keypair') {
                                 const bodyParameters = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{name?: string, value?: string}>;
                                 const params = new URLSearchParams();
                                 bodyParameters.forEach(param => {
                                     if (param.name) params.append(param.name, param.value ?? '');
                                 });
                                 requestOptions.body = params.toString();
                                 requestOptions.json = false; // Explicitly not JSON
                             } else {
                                 throw new NodeOperationError(this.getNode(), 'For form-urlencoded, please use "Using Fields Below" to specify body.', { itemIndex });
                             }
                             // Remove 'form' property if it existed from previous attempts
                             // delete (requestOptions as any).form;

                         } else if (contentType === 'multipart-form-data') {
                              if (sendMultipart) {
                                  const multipartParameters = this.getNodeParameter('multipartParameters.values', itemIndex, []) as Array<{name?: string, value?: any, type?: string, contentType?: string, filename?: string}>;
                                  const formData: IDataObject = {}; // Build formData object for the helper
                                  for (const part of multipartParameters) {
                                      if (!part.name) continue;

                                      let value = part.value;
                                      if (part.type === 'binary') {
                                          // Use correct helper signature (expects 2 arguments)
                                          const binaryData = this.helpers.assertBinaryData(itemIndex, value);
                                          const partOptions: any = {};
                                          if (part.contentType) partOptions.contentType = part.contentType;
                                          // Use filename from parameter OR from binary data property
                                          const filename = part.filename || binaryData.fileName;
                                          if (filename) partOptions.filename = filename;
                                          // Use mimeType from binary data if contentType not specified
                                          if (binaryData.mimeType && !partOptions.contentType) partOptions.contentType = binaryData.mimeType;

                                          value = {
                                              value: Buffer.from(binaryData.data, 'base64'),
                                              options: partOptions
                                          };
                                      }
                                      formData[part.name] = value;
                                  }
                                  requestOptions.formData = formData; // Pass formData object to helper
                                  // Content-Type header is set automatically by the helper for formData
                                  delete requestOptions.headers['content-type'];
                                  requestOptions.json = false; // Explicitly not JSON
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
                             delete (requestOptions as any).json; // Ensure json flag is not set
                         }
                     }

                     // --- Webhook Wait Logic ---
                     if (waitForWebhookResponse) {
                         const correlationIdValue = uuidv4();
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

                         // 1. Construct Webhook URL
                         // Use the correct helper: this.getWebhookUrl
                         const webhookUrl = this.getWebhookUrl('default', { webhookId: webhookUniqueId });
                         if (!webhookUrl) {
                             throw new NodeOperationError(this.getNode(), 'Could not generate webhook URL. Ensure Instance Base URL is configured.', { itemIndex });
                         }

                         // 2. Inject Correlation ID into the request
                         AsyncHttpRequest.handleCorrelationData(
                             correlationIdLocationInRequest,
                             correlationIdParameterName as string,
                             requestOptions,
                             correlationIdValue,
                             false,
                             this.getNode() // Pass INode here
                         );

                         // 3. Inject Callback URL into the request
                         AsyncHttpRequest.handleCorrelationData(
                             callbackUrlLocationInRequest,
                             callbackUrlParameterNameInRequest as string,
                             requestOptions,
                             webhookUrl,
                             false,
                             this.getNode() // Pass INode here
                         );


                         // 4. Define Waiter Promise & Register Listener
                         const waitPromise = new Promise<IDataObject>((resolve, reject) => {
                             const timeoutSeconds = (timeoutWebhook as number) * 1000;
                             const timer = setTimeout(() => {
                                 if (webhookListeners[webhookUniqueId]) {
                                     const listenerItemIndex = webhookListeners[webhookUniqueId].itemIndex;
                                     delete webhookListeners[webhookUniqueId];
                                     reject(new NodeOperationError(this.getNode(), `Webhook wait timed out after ${timeoutWebhook} seconds for ID ${webhookUniqueId}`, { itemIndex: listenerItemIndex }));
                                 }
                             }, timeoutSeconds);

                             webhookListeners[webhookUniqueId] = {
                                 resolve,
                                 reject,
                                 timeoutTimer: timer,
                                 expectedMethod: (webhookMethod as string).toUpperCase(),
                                 correlationId: correlationIdValue,
                                 webhookConfig: webhookConfig,
                                 itemIndex: itemIndex
                             };
                             this.logger.debug(`Webhook Listener Added: ${webhookUniqueId} for Correlation ID: ${correlationIdValue}`);
                         });

                         // 5. Send Initial HTTP Request
                         let initialResponse: any;
                         try {
                             this.logger.debug(`Sending initial request [${itemIndex}] for ${webhookUniqueId} (Correlation: ${correlationIdValue}): ${JSON.stringify(requestOptions)}`);

                             // Cast 'this' context if necessary, though usually not needed for standard helpers
                             initialResponse = await (this.helpers as RequestHelperFunctions).requestWithAuthentication(
                                 authentication,
                                 requestOptions,
                                 itemIndex
                             );

                             this.logger.debug(`Initial request [${itemIndex}] sent successfully for ${webhookUniqueId}. Status: ${initialResponse?.statusCode}. Waiting for webhook...`);
                         } catch (error: any) {
                             const listenerData = webhookListeners[webhookUniqueId];
                             if (listenerData) {
                                 clearTimeout(listenerData.timeoutTimer);
                                 delete webhookListeners[webhookUniqueId];
                                 this.logger.debug(`Webhook Listener Removed due to initial request error: ${webhookUniqueId}`);
                             }

                             if (!this.getNodeParameter('options.ignoreResponseCode', itemIndex, false) as boolean || !isNodeApiError(error)) {
                                 throw error; // Re-throw critical errors or if not ignoring API errors
                             } else {
                                 this.logger.warn(`Initial HTTP request [${itemIndex}] failed but ignoring response code. Error: ${error.message}. Status Code: ${error.context?.statusCode}. Proceeding to wait for webhook ${webhookUniqueId}.`);
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
                              // Cast 'this' context if necessary
                             response = await (this.helpers as RequestHelperFunctions).requestWithAuthentication(
                                  authentication,
                                  requestOptions,
                                  itemIndex
                             );

                             let responseData: any;
                             let binaryPropertyName: string | undefined = undefined;

                             // Check response body type (Buffer means binary or text needing decoding)
                             const responseBody = response.body;
                             const isBuffer = Buffer.isBuffer(responseBody);

                             // Handle response formatting
                             if (!fullResponse) {
                                 if (responseFormat === 'file') {
                                     if (!isBuffer) {
                                         throw new NodeOperationError(this.getNode(), 'Response body is not binary data (Buffer), cannot format as file.', { itemIndex });
                                     }
                                     const mimeType = response.headers['content-type']?.split(';')[0] || 'application/octet-stream';
                                     // Use helpers for binary data - this returns structured binary data for n8n
                                      const binaryData = await (this.helpers as BinaryHelperFunctions).prepareBinaryData(responseBody, undefined, mimeType);
                                      // Standard way to return binary data is in the 'binary' property
                                     binaryPropertyName = 'data'; // Default binary property name
                                     responseData = {}; // JSON part is empty
                                     returnData.push({ json: responseData, binary: { [binaryPropertyName]: binaryData }, pairedItem: { item: itemIndex } });
                                     continue; // Skip standard returnData.push below

                                 } else if (responseFormat === 'text') {
                                      responseData = isBuffer ? responseBody.toString(requestOptions.encoding || undefined) : String(responseBody);
                                 } else if (responseFormat === 'json') {
                                      // If helper returned JSON directly
                                     if (typeof responseBody === 'object' && !isBuffer) {
                                          responseData = responseBody;
                                     } else {
                                         // If it's buffer or string, try parsing
                                         const textBody = isBuffer ? responseBody.toString(requestOptions.encoding || 'utf8') : String(responseBody);
                                         try {
                                             responseData = JSON.parse(textBody);
                                         } catch (e: any) {
                                             throw new NodeOperationError(this.getNode(), `Response body could not be parsed as JSON: ${e.message}`, { itemIndex /* removed cause: e */ });
                                         }
                                     }
                                 } else { // Autodetect
                                     if (typeof responseBody === 'object' && !isBuffer) { // Already parsed JSON?
                                         responseData = responseBody;
                                     } else { // Treat as text
                                         responseData = isBuffer ? responseBody.toString(requestOptions.encoding || 'utf8') : String(responseBody);
                                         // Optional: Could try JSON.parse here and fallback to text
                                     }
                                 }
                             } else { // Full Response requested
                                 let processedBody = responseBody;
                                  if (isBuffer) {
                                       // Try to decode buffer for preview based on expected format
                                       if (responseFormat === 'text' || responseFormat === 'json' || responseFormat === 'autodetect') {
                                           try {
                                                processedBody = responseBody.toString(requestOptions.encoding || 'utf8');
                                                if (responseFormat === 'json' || (responseFormat === 'autodetect' && response.headers['content-type']?.includes('json'))) {
                                                     processedBody = JSON.parse(processedBody);
                                                }
                                           } catch(e) {
                                               this.logger.warn(`Could not decode/parse buffer body for full response preview: ${e}`);
                                               processedBody = `Buffer data (length: ${responseBody.length}, Base64: ${responseBody.toString('base64').substring(0, 100)}...)`; // Placeholder
                                           }
                                       } else { // 'file' format
                                          processedBody = `Binary file data (length: ${responseBody.length}, type: ${response.headers['content-type']})`; // Placeholder
                                       }
                                  } else if (typeof processedBody === 'object' && responseFormat === 'text') {
                                       // Stringify object body if response format was text
                                       processedBody = JSON.stringify(processedBody);
                                  }
                                 // Structure the full response output
                                 responseData = {
                                     headers: response.headers,
                                     body: processedBody,
                                     statusCode: response.statusCode,
                                     statusMessage: response.statusMessage,
                                 };
                             }

                             // Add the processed data to the return array (unless binary handled above)
                             returnData.push({ json: responseData, pairedItem: { item: itemIndex } });

                         } catch (error: any) {
                             // Check if it's an API error from the request helper
                             if (!this.getNodeParameter('options.ignoreResponseCode', itemIndex, false) as boolean || !isNodeApiError(error)) {
                                 throw error; // Re-throw if not ignoring or not a standard API error
                             }

                             // If ignoring response code for NodeApiError, format the error output
                             const errorContext = error.context ?? {};
                             const returnErrorData: IDataObject = {
                                 error: {
                                     message: error.message,
                                     // Access stack safely
                                     stack: typeof error.stack === 'string' ? error.stack.split('\n').map((line:string) => line.trim()) : undefined,
                                     httpCode: errorContext.statusCode, // Use standardized name if available
                                     httpMessage: errorContext.statusMessage,
                                     headers: errorContext.headers,
                                     body: errorContext.body, // Include body from error context if available
                                     // Avoid adding the whole context object unless necessary
                                     // context: errorContext
                                 }
                             };
                             returnData.push({ json: returnErrorData, pairedItem: { item: itemIndex } });
                         }
                     }

                 } catch (error: any) {
                     // Use the helper without arguments
                     if (this.continueOnFail()) {
                         const errorData: IDataObject = { error: { message: error.message } };
                          // Safely access stack
                         if (error.stack && typeof error.stack === 'string') {
                            errorData.error.stack = error.stack.split('\n').map((line:string) => line.trim());
                         }
                         // Safely access context from NodeOperationError or NodeApiError
                         if (error instanceof NodeOperationError && error.context) {
                              errorData.error.context = error.context;
                         } else if (isNodeApiError(error) && error.context) {
                              errorData.error.context = error.context;
                         }

                         returnData.push({ json: errorData, pairedItem: { item: itemIndex } });
                         continue;
                     }
                     // If not continuing on fail, re-throw
                     throw error; // Already likely a NodeOperationError or NodeApiError
                 }
             }

             return [returnData];
         }


     /**
      * Static webhook handler. 'this' context is IWebhookFunctions.
      */
     static async webhook(this: IWebhookFunctions): Promise<void> {
         const req = this.getRequestObject();
         const node = this.getNode(); // Get INode context

         // Extract the unique webhook ID from the request path parameter (:webhookId)
         const webhookUniqueId = req.params?.webhookId as string | undefined;

         if (!webhookUniqueId) {
              this.logger.warn(`Webhook received without a webhookId in path parameters.`);
              // Cannot send response directly, throw error to signal failure
              throw new NodeOperationError(node, 'Missing webhook identifier in URL path.');
              // If we could set status: this.res.status(400).send(...)
             return;
         }

         this.logger.debug(`Webhook received for ID: ${webhookUniqueId}`);

         // Retrieve the listener map from static data for this execution
         // Ensure static data structure exists
         const staticData = this.getWorkflowStaticData('node');
         const webhookListeners = staticData.listeners as { [key: string]: IWebhookListener } || {};
         const listenerData = webhookListeners[webhookUniqueId];

         if (listenerData) {
             const { resolve, reject, timeoutTimer, expectedMethod, correlationId, webhookConfig, itemIndex } = listenerData;

             // Check HTTP Method
             const receivedMethod = (req.method ?? '').toUpperCase();
             if (receivedMethod !== expectedMethod) {
                 this.logger.warn(`Webhook ${webhookUniqueId}: Received method ${receivedMethod}, expected ${expectedMethod}. Ignoring.`);
                 // Cannot send 405 directly, maybe throw specific error?
                 // Or just ignore and let it timeout eventually.
                 // Let n8n core handle the response (likely 200 OK from definition, which isn't ideal)
                 return;
             }

             try {
                 // Extract correlation ID from the incoming webhook request
                 const receivedCorrelationId = AsyncHttpRequest.handleCorrelationData(
                     webhookConfig.correlationIdLocationInWebhook as any,
                     webhookConfig.correlationIdParameterNameInWebhook as string,
                     req,
                     undefined,
                     true,
                     node // Pass INode
                 ) as string | undefined;

                 this.logger.debug(`Webhook ${webhookUniqueId}: Expecting CorrelationID ${correlationId}, Received ${receivedCorrelationId}`);

                 // Validate correlation ID
                 if (receivedCorrelationId === correlationId) {
                     clearTimeout(timeoutTimer);
                     delete webhookListeners[webhookUniqueId];
                     this.logger.info(`Webhook ${webhookUniqueId}: Correlation ID match! Resolving promise.`);

                     // Construct response based on user selection
                     const webhookResult: IDataObject = {};
                      // Ensure webhookResponseIncludes is an array, default to ['body']
                     const includes = Array.isArray(webhookConfig.webhookResponseIncludes) ? webhookConfig.webhookResponseIncludes : ['body'];

                     if (includes.includes('body')) webhookResult.body = req.body;
                     if (includes.includes('headers')) webhookResult.headers = req.headers;
                     if (includes.includes('query')) webhookResult.query = req.query;

                     resolve(webhookResult); // Resolve the waiting promise

                     // n8n core should send the 200 OK response based on webhook definition
                     // Removed: this.sendResponse(200, ...);

                 } else {
                     // Correlation ID mismatch - log it but keep listening.
                     this.logger.warn(`Webhook ${webhookUniqueId}: Correlation ID mismatch. Expected ${correlationId}, got ${receivedCorrelationId}. Ignoring webhook call.`);
                     // Let n8n core send the default response (e.g., 200 OK)
                     // Removed: this.sendResponse(400, ...);
                 }
             } catch (error: any) {
                 // Error during webhook processing (e.g., accessing body path)
                 this.logger.error(`Webhook ${webhookUniqueId}: Error processing incoming webhook: ${error.message}`, { error });

                 // Reject the waiting promise
                 clearTimeout(timeoutTimer);
                 delete webhookListeners[webhookUniqueId];
                 // Reject with a NodeOperationError
                 reject(new NodeOperationError(node, `Error processing webhook ${webhookUniqueId}: ${error.message}`, { itemIndex }));

                 // Let n8n core handle sending an error response (likely 500)
                 // Removed: this.sendResponse(500, ...);
                 // Re-throwing might be necessary for n8n core to catch it properly
                 throw error;
             }
         } else {
             // No active listener found
             this.logger.warn(`Webhook received for unknown or inactive listener ID: ${webhookUniqueId}. Ignoring.`);
             // Let n8n core send the default response (e.g., 200 OK, or potentially 404 if route setup allows)
             // Removed: this.sendResponse(404, ...);
             // Throwing an error might result in a 500, which is better than silent ignore/200
             throw new NodeOperationError(node, `Webhook listener not found for ID: ${webhookUniqueId}`);
         }
     }
}
