import {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	INodeExecutionData,
	NodeOperationError,
	HttpRequestOptions,
	IHttpRequestMethods,
	IDataObject,
	NodeApiError,
	// NodeConnectionType, // Not directly used here, but often relevant
	// INodePropertyOptions, // Implicitly used via description
} from 'n8n-workflow';

import { OptionsWithUri } from 'request-promise-native';
// import { URL } from 'url'; // Node.js built-in, no need to explicitly import usually
import { v4 as uuidv4 } from 'uuid'; // For generating correlation IDs
import * as objectPath from 'object-path'; // For handling JSON paths

// Define an interface for the webhook configuration parameters for better type safety
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

// Define an interface for the incoming webhook request structure for clarity
interface IWebhookRequest {
	headers: IDataObject;
	params: IDataObject; // URL path parameters (if applicable)
	query: IDataObject;
	body: IDataObject | string | undefined; // Body can be parsed JSON or raw
	method?: string; // HTTP Method
	path?: string;   // Request path
}

export class AsyncHttpRequest implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Async HTTP Request',
		name: 'asyncHttpRequest',
		icon: 'fa:exchange-alt', // Consider creating a custom AsyncHttpRequest.svg
		group: ['helpers'],
		version: 1,
		description: 'Sends an HTTP request and optionally waits for a correlated asynchronous response via webhook.',
		defaults: {
			name: 'Async HTTP Request',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			// Credentials definitions remain the same as before...
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
					{ name: 'Using JSON', value: 'json', displayOptions: { show: { contentType: ['json'] } } },
					{ name: 'Using Raw Body', value: 'raw', displayOptions: { show: { contentType: ['raw'] } } },
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
					{ displayName: 'Batching', name: 'batching', type: 'boolean', default: false, description: 'Whether to enables batching. The node will wait until all executions of the node have finished, then make one API request for all items.' },
					{ displayName: 'Ignore Response Code', name: 'ignoreResponseCode', type: 'boolean', default: false, description: 'Whether to succeed even if the HTTP status code indicates an error' },
					{ displayName: 'Allow Unauthorized Certificates', name: 'allowUnauthorizedCerts', type: 'boolean', default: false, description: 'Whether to allow unauthorized certificates (e.g. self-signed)' },
					{ displayName: 'Timeout (ms)', name: 'timeout', type: 'number', typeOptions: { minValue: 1 }, default: 10000, description: 'Time in milliseconds to wait for the request to complete' },
					{ displayName: 'Proxy', name: 'proxy', type: 'string', default: '', placeholder: 'http://myproxy:3128', description: 'HTTP proxy to use for the request' },
					{ displayName: 'Response Format', name: 'responseFormat', type: 'options', options: [ { name: 'Autodetect', value: 'autodetect' }, { name: 'File', value: 'file' }, { name: 'JSON', value: 'json' }, { name: 'Text', value: 'text' } ], default: 'autodetect', description: 'How to format the response data' },
					{ displayName: 'Response Character Encoding', name: 'responseCharacterEncoding', type: 'options', displayOptions: { show: { responseFormat: ['text', 'json', 'autodetect'] } }, options: [ { name: 'Autodetect', value: 'autodetect' }, { name: 'ISO-8859-1', value: 'latin1'}, { name: 'UTF-8', value: 'utf8'} ], default: 'autodetect', description: 'Character encoding for text based response formats like JSON and Text.' },
					{ displayName: 'Full Response', name: 'fullResponse', type: 'boolean', default: false, description: 'Whether to return the full response object (including headers, status code) instead of just the body' },
				],
			},
			// Webhook Response properties remain the same...
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
					{ displayName: 'Correlation ID Parameter Name (in Request)', name: 'correlationIdParameterName', type: 'string', default: 'correlationId', required: true, displayOptions: { show: { '/correlationIdLocationInRequest': ['query', 'header', 'bodyJsonPath'] } }, description: 'Name of the query parameter, header, or the JSON path (dot notation) for the correlation ID in the initial request' },
					{ displayName: 'Callback URL Parameter Name (in Request)', name: 'callbackUrlParameterNameInRequest', type: 'string', default: 'callbackUrl', required: true, description: 'Parameter name (query, header, or body JSON path) used to send the generated webhook callback URL in the initial request' },
					{ displayName: 'Callback URL Location (in Request)', name: 'callbackUrlLocationInRequest', type: 'options', options: [ { name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' } ], default: 'bodyJsonPath', description: 'Where to place the webhook callback URL in the initial outbound HTTP request' },
					{ displayName: 'Correlation ID Location (in Webhook)', name: 'correlationIdLocationInWebhook', type: 'options', options: [ { name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' } ], required: true, default: 'bodyJsonPath', description: 'Where to find the correlation ID in the incoming webhook data to match the request' },
					{ displayName: 'Correlation ID Parameter Name (in Webhook)', name: 'correlationIdParameterNameInWebhook', type: 'string', default: 'correlationId', required: true, description: 'Name of the query parameter, header, or the JSON path (dot notation) for the correlation ID in the webhook response' },
					{ displayName: 'Webhook Timeout (seconds)', name: 'timeoutWebhook', type: 'number', typeOptions: { minValue: 1 }, default: 120, description: 'Maximum time (in seconds) to wait for the correct webhook response' },
					{ displayName: 'Webhook Response Includes', name: 'webhookResponseIncludes', type: 'multiOptions', options: [ { name: 'Body', value: 'body' }, { name: 'Headers', value: 'headers' }, { name: 'Query Parameters', value: 'query' } ], required: true, default: ['body'], description: 'Which parts of the incoming webhook request to include in the node output' },
				],
			},
		],
	};

	// --- Webhook Listener Management ---
	// IMPORTANT: This is a conceptual in-memory store.
	// A robust solution needs integration with n8n's core webhook processing
	// and potentially a shared store (like Redis) if running multi-worker.
	private static webhookListeners = new Map<string, { resolve: (data: IDataObject) => void; reject: (reason?: any) => void; timeoutTimer: NodeJS.Timeout, expectedMethod: string, correlationId: string, webhookConfig: IWebhookConfig, nodeInstance: AsyncHttpRequest, itemIndex: number }>();

	// Centralized method to handle correlation ID injection/extraction
	private handleCorrelationData(
		location: 'query' | 'header' | 'bodyJsonPath' | 'none',
		paramName: string,
		data: IDataObject | HttpRequestOptions | IWebhookRequest, // Union type for flexibility
		valueToSet?: string, // Only provided when injecting
		isWebhookRequest: boolean = false, // Flag to differentiate context
	): string | undefined | void {
		try {
			if (location === 'query') {
				const target = isWebhookRequest ? (data as IWebhookRequest).query : (data as HttpRequestOptions).qs;
				if (valueToSet !== undefined) { // Injecting
					if (!target) (data as HttpRequestOptions).qs = {}; // Initialize qs if injecting into request
					((data as HttpRequestOptions).qs as IDataObject)[paramName] = valueToSet;
				} else { // Extracting
					return (target as IDataObject)?.[paramName] as string | undefined;
				}
			} else if (location === 'header') {
				const target = isWebhookRequest ? (data as IWebhookRequest).headers : (data as HttpRequestOptions).headers;
				if (valueToSet !== undefined) { // Injecting
					if (!target) (data as HttpRequestOptions).headers = {}; // Initialize headers if injecting
					((data as HttpRequestOptions).headers as IDataObject)[paramName] = valueToSet;
				} else { // Extracting
					const lowerCaseParamName = paramName.toLowerCase();
					const headers = target as IDataObject | undefined;
					if (!headers) return undefined;
					const foundKey = Object.keys(headers).find(key => key.toLowerCase() === lowerCaseParamName);
					return foundKey ? headers[foundKey] as string : undefined;
				}
			} else if (location === 'bodyJsonPath') {
				let body = isWebhookRequest ? (data as IWebhookRequest).body : (data as HttpRequestOptions).body;
				if (valueToSet !== undefined) { // Injecting
                    let currentBody = (data as HttpRequestOptions).body;
                    let bodyIsObject = typeof currentBody === 'object' && currentBody !== null;

                    // Attempt to parse if string and seems like JSON
                    if (typeof currentBody === 'string' && (data as HttpRequestOptions)?.headers?.['content-type']?.includes('json')) {
                         try {
                            currentBody = JSON.parse(currentBody);
                            bodyIsObject = true;
                         } catch (e) {
                             console.warn(`Could not parse existing string body as JSON for path injection. Proceeding with caution.`);
                             bodyIsObject = false; // Treat as non-object if parsing fails
                         }
                    }

                    // Initialize body as object if needed for path setting
                    if (!bodyIsObject) {
                        currentBody = {};
                    }

                    objectPath.set(currentBody as IDataObject, paramName, valueToSet);
                    (data as HttpRequestOptions).body = currentBody; // Re-assign potentially modified/initialized body

				} else { // Extracting
					// Ensure webhook body is parsed if it's a JSON string
					let parsedBody = body;
					if (typeof body === 'string') {
						try {
							parsedBody = JSON.parse(body);
						} catch (e) {
							// Ignore parsing error, treat as non-object body for path extraction
							parsedBody = undefined; // Or keep as string if path could target the string itself? Unlikely.
						}
					}
					if (typeof parsedBody === 'object' && parsedBody !== null) {
						return objectPath.get(parsedBody, paramName) as string | undefined;
					}
					return undefined; // Cannot get path from non-object body
				}
			}
			// 'none' location does nothing during injection and returns undefined during extraction
		} catch (error) {
			throw new NodeOperationError(this.getNode(), `Error accessing path "${paramName}" in ${valueToSet ? 'request' : 'webhook'} data for location "${location}": ${error.message}`, { itemIndex: isWebhookRequest ? undefined : 0 }); // Provide itemIndex context if available
		}
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const fullResponse = this.getNodeParameter('options.fullResponse', 0, false) as boolean;
		const batching = this.getNodeParameter('options.batching', 0, false) as boolean;

		const waitForWebhookResponseGlobal = this.getNodeParameter('waitForWebhookResponse', 0, false) as boolean;

		if (batching && items.length > 1 && !waitForWebhookResponseGlobal) {
            console.warn("Batching is enabled but not fully implemented in this custom node example, especially with webhook waits. Each item will be processed individually.");
            // Fallthrough to individual processing. Proper batching would require API support
            // and logic to combine requests/responses.
        }

		// Process each item individually
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const waitForWebhookResponse = this.getNodeParameter('waitForWebhookResponse', itemIndex, false) as boolean; // Check per item if needed, though usually global
			const webhookConfig = this.getNodeParameter('webhookConfig', itemIndex, {}) as IWebhookConfig; // Get config per item

			try {
				const method = this.getNodeParameter('method', itemIndex, 'GET') as IHttpRequestMethods;
				const url = this.getNodeParameter('url', itemIndex, '') as string;
				const authentication = this.getNodeParameter('authentication', itemIndex, 'none') as string;
				const sendBody = this.getNodeParameter('sendBody', itemIndex, false) as boolean;
				const contentType = this.getNodeParameter('contentType', itemIndex, 'json') as string;
				const rawContentType = this.getNodeParameter('rawContentType', itemIndex, 'text/plain') as string; // Get raw content type
				const specifyBody = this.getNodeParameter('specifyBody', itemIndex, 'keypair') as string;
				const sendQuery = this.getNodeParameter('sendQuery', itemIndex, false) as boolean;
				const sendHeaders = this.getNodeParameter('sendHeaders', itemIndex, false) as boolean;
				const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;

				const requestOptions: HttpRequestOptions = {
					method,
					uri: url,
					gzip: true,
					rejectUnauthorized: !(options.allowUnauthorizedCerts as boolean | undefined ?? false),
					timeout: (options.timeout as number | undefined) ?? 10000,
					proxy: options.proxy as string | undefined,
					encoding: options.responseCharacterEncoding === 'autodetect' || options.responseCharacterEncoding === undefined ? null : options.responseCharacterEncoding as BufferEncoding | null,
					headers: {}, // Initialize headers
					// Resolve with full response to access headers/status later if needed
					resolveWithFullResponse: true,
				};

				// --- Authentication ---
				requestOptions.auth = await this.getCredentials(authentication, itemIndex);

				// --- Headers ---
				if (sendHeaders) {
					const headerParameters = this.getNodeParameter('headerParameters.values', itemIndex, []) as IDataObject[];
					requestOptions.headers = headerParameters.reduce((acc, param) => {
						if (param.name) acc[param.name as string] = param.value as string;
						return acc;
					}, requestOptions.headers); // Start with potentially existing headers
				}

				// --- Query Parameters ---
				if (sendQuery) {
					const queryParameters = this.getNodeParameter('queryParameters.values', itemIndex, []) as IDataObject[];
					requestOptions.qs = queryParameters.reduce((acc, param) => {
						if (param.name) acc[param.name as string] = param.value as string;
						return acc;
					}, {} as IDataObject);
				}

				// --- Body ---
				if (sendBody && ['POST', 'PATCH', 'PUT'].includes(method)) {
					// Ensure headers object exists
					requestOptions.headers = requestOptions.headers ?? {};

					if (contentType === 'json') {
						requestOptions.headers['content-type'] = 'application/json';
						if (specifyBody === 'keypair') {
							const bodyParameters = this.getNodeParameter('bodyParameters.values', itemIndex, []) as IDataObject[];
							requestOptions.body = bodyParameters.reduce((acc, param) => {
								if (param.name) acc[param.name as string] = param.value; // Keep original types if possible
								return acc;
							}, {} as IDataObject);
						} else if (specifyBody === 'json') {
							const jsonBodyStr = this.getNodeParameter('jsonBody', itemIndex, '{}') as string;
							try {
								requestOptions.body = JSON.parse(jsonBodyStr);
							} catch (e) {
								throw new NodeOperationError(this.getNode(), `Invalid JSON in body: ${e.message}`, { itemIndex });
							}
						}
						requestOptions.json = true; // Let request library handle stringification
					} else if (contentType === 'form-urlencoded') {
						requestOptions.headers['content-type'] = 'application/x-www-form-urlencoded';
						if (specifyBody === 'keypair') {
							const bodyParameters = this.getNodeParameter('bodyParameters.values', itemIndex, []) as IDataObject[];
							requestOptions.form = bodyParameters.reduce((acc, param) => {
								if (param.name) acc[param.name as string] = param.value as string;
								return acc;
							}, {} as IDataObject);
						} else {
                            throw new NodeOperationError(this.getNode(), 'For form-urlencoded, please use "Using Fields Below" to specify body.', { itemIndex });
                        }
					} else if (contentType === 'multipart-form-data') {
						// Placeholder - requires complex handling with formData library/logic
						requestOptions.headers['content-type'] = 'multipart/form-data'; // Usually set by the library
                        throw new NodeOperationError(this.getNode(), 'Multipart form-data body is not fully implemented in this example.', { itemIndex });
                        // Example: requestOptions.formData = { field1: 'value', fileField: fs.createReadStream(...) };
					} else if (contentType === 'raw') {
						requestOptions.headers['content-type'] = rawContentType;
						requestOptions.body = this.getNodeParameter('rawBody', itemIndex, '') as string;
                        requestOptions.json = false; // Explicitly not JSON
                        delete requestOptions.form; // Ensure form is not set
					} else if (contentType === 'none') {
						// Maybe remove content-type? Or let request handle it.
						delete requestOptions.headers['content-type'];
                        delete requestOptions.body;
                        delete requestOptions.json;
                        delete requestOptions.form;
					}
				}

				// --- Webhook Wait Logic ---
				if (waitForWebhookResponse) {
					const correlationId = uuidv4();
					// Use a combination that is unique *per execution run* and *per item* within that run
                    const workflowExecutionId = this.getExecutionId();
                    const webhookUniqueId = `${this.getNode().id}-${workflowExecutionId}-${itemIndex}-${correlationId}`; // Unique ID for the listener

					const {
						webhookMethod = 'POST',
						correlationIdLocationInRequest = 'none',
						correlationIdParameterName = 'correlationId',
						callbackUrlParameterNameInRequest = 'callbackUrl',
						callbackUrlLocationInRequest = 'bodyJsonPath',
						correlationIdLocationInWebhook = 'bodyJsonPath',
						correlationIdParameterNameInWebhook = 'correlationId',
						timeoutWebhook = 120,
						webhookResponseIncludes = ['body'],
					} = webhookConfig;

					// 1. Construct Webhook URL
					// 'default' is the standard endpoint; unique ID handles routing
					const webhookUrl = this.getNodeWebhookUrl('default', webhookUniqueId);
					if (!webhookUrl) {
						throw new NodeOperationError(this.getNode(), 'Could not generate webhook URL. Ensure Instance Base URL is configured correctly in n8n settings.', { itemIndex });
					}

					// 2. Inject Correlation ID into the request
					this.handleCorrelationData(
						correlationIdLocationInRequest,
						correlationIdParameterName as string,
						requestOptions, // Pass the options object
						correlationId,
                        false // It's a request injection
					);

                    // 3. Inject Callback URL into the request
                    this.handleCorrelationData(
                        callbackUrlLocationInRequest,
                        callbackUrlParameterNameInRequest as string,
                        requestOptions, // Pass the options object
                        webhookUrl,
                        false // It's a request injection
                    );

                    // Ensure body is stringified if needed after injection
                    if (typeof requestOptions.body === 'object' && requestOptions.body !== null && !requestOptions.json && !requestOptions.form && !requestOptions.formData) {
                         if (requestOptions?.headers?.['content-type']?.includes('json')) {
                            try {
                                requestOptions.body = JSON.stringify(requestOptions.body);
                            } catch(e) {
                                 throw new NodeOperationError(this.getNode(), `Failed to stringify JSON body after injection: ${e.message}`, { itemIndex });
                            }
                         }
                    }

					// 4. Define the Waiter Promise & Register Listener
                    const waitPromise = new Promise<IDataObject>((resolve, reject) => {
                        const timeoutSeconds = (timeoutWebhook as number) * 1000;
                        const timer = setTimeout(() => {
							// Check if the listener still exists before trying to remove/reject
							if (AsyncHttpRequest.webhookListeners.has(webhookUniqueId)) {
								AsyncHttpRequest.webhookListeners.delete(webhookUniqueId);
								reject(new NodeOperationError(this.getNode(), `Webhook wait timed out after ${timeoutWebhook} seconds for ID ${webhookUniqueId}`, { itemIndex }));
							}
                        }, timeoutSeconds);

						// Store the listener details
                        AsyncHttpRequest.webhookListeners.set(webhookUniqueId, {
                            resolve,
                            reject,
                            timeoutTimer: timer,
							expectedMethod: (webhookMethod as string).toUpperCase(),
							correlationId: correlationId,
							webhookConfig: webhookConfig, // Store config for extraction logic
							nodeInstance: this, // Pass 'this' context for calling helpers inside the static handler
							itemIndex: itemIndex
						});
						console.debug(`Webhook Listener Added: ${webhookUniqueId} for Correlation ID: ${correlationId}`);
                    });

					// 5. Send Initial HTTP Request
					let initialResponse: any;
					try {
                        console.debug(`Sending initial request [${itemIndex}] for ${correlationId}: ${JSON.stringify(requestOptions)}`);
                        // We need resolveWithFullResponse to potentially check status code even if ignoring body
						initialResponse = await this.helpers.request(requestOptions as OptionsWithUri);
                        console.debug(`Initial request [${itemIndex}] sent successfully for ${correlationId}. Status: ${initialResponse?.statusCode}. Waiting for webhook...`);
					} catch (error) {
						// Cleanup listener immediately if initial request fails hard
                        const listenerData = AsyncHttpRequest.webhookListeners.get(webhookUniqueId);
                        if (listenerData) {
							clearTimeout(listenerData.timeoutTimer);
							AsyncHttpRequest.webhookListeners.delete(webhookUniqueId);
							console.debug(`Webhook Listener Removed due to initial request error: ${webhookUniqueId}`);
						}

						// Handle ignoreResponseCode for the *initial* request
						if (!options.ignoreResponseCode || !(error instanceof NodeApiError)) {
							throw error; // Re-throw critical errors or if not ignoring
						} else {
                             // Log the error but continue to wait for webhook if ignoring response code
                            console.warn(`Initial HTTP request [${itemIndex}] failed but ignoring response code. Error: ${error.message}. Status Code: ${error.context?.statusCode}. Proceeding to wait for webhook ${webhookUniqueId}.`);
                             // Optionally store the initial error details if needed later
                             // initialResponse = { error: error.message, statusCode: error.context?.statusCode };
						}
					}

                    // 6. Wait for the correct webhook
                    console.debug(`Waiting for webhook ${webhookUniqueId}...`);
					const webhookResult = await waitPromise;

					// 7. Prepare output data from webhook
					returnData.push({ json: webhookResult, pairedItem: { item: itemIndex } });

				} else {
					// --- Standard HTTP Request Execution ---
					let response: any; // Will contain the full response object
					try {
						// Request with full response needed for header/status access
						response = await this.helpers.request({ ...requestOptions, resolveWithFullResponse: true } as OptionsWithUri);

						let responseData: any = response.body; // Start with the body

						// Handle non-full response formatting (if requested)
						if (!fullResponse) {
							if (options.responseFormat === 'file') {
								// Handle binary data
								if (!Buffer.isBuffer(response.body)) {
									throw new NodeOperationError(this.getNode(), 'Response body is not a Buffer, cannot format as file.', { itemIndex });
								}
								const mimeType = response.headers['content-type']?.split(';')[0] || 'application/octet-stream';
								const extension = this.helpers.mimeTypeToExtension(mimeType);
								const fileName = `file_${itemIndex}.${extension}`;
								const binaryData = await this.helpers.prepareBinaryData(response.body, fileName, mimeType);
								// Structure for binary output
								responseData = { data: binaryData }; // Needs special handling downstream if just returning this structure
								// Correct approach: Push binary data directly
								returnData.push({ json: {}, binary: { data: binaryData }, pairedItem: { item: itemIndex } });
								continue; // Skip standard returnData.push below for binary

							} else if (options.responseFormat === 'text') {
								// Ensure it's text
								responseData = Buffer.isBuffer(response.body) ? response.body.toString(requestOptions.encoding || 'utf8') : (typeof response.body === 'object' ? JSON.stringify(response.body) : response.body);
							} else if (options.responseFormat === 'json') {
								// Try to parse if not already an object (request lib might parse automatically)
								if (typeof response.body === 'string') {
									try {
										responseData = JSON.parse(response.body);
									} catch (e) {
										throw new NodeOperationError(this.getNode(), `Response body is not valid JSON: ${e.message}`, { itemIndex, cause: e });
									}
								} else if (Buffer.isBuffer(response.body)) {
                                    try {
										responseData = JSON.parse(response.body.toString(requestOptions.encoding || 'utf8'));
									} catch (e) {
										throw new NodeOperationError(this.getNode(), `Response body buffer is not valid JSON: ${e.message}`, { itemIndex, cause: e });
									}
                                }
                                // If already object, use as is
							}
                            // 'autodetect' is mostly handled by request library or defaults to body
						} else {
                            // Full response requested - structure it
                            responseData = {
                                headers: response.headers,
                                body: response.body, // Keep original body format (might be buffer, string, object)
                                statusCode: response.statusCode,
                                statusMessage: response.statusMessage,
                            };
                        }

						returnData.push({ json: responseData, pairedItem: { item: itemIndex } });

					} catch (error) {
						if (!options.ignoreResponseCode || !(error instanceof NodeApiError)) {
							throw error; // Re-throw if not ignoring or not an API error
						}
                         // If ignoring response code, return the error details
                        const errorContext = (error as NodeApiError).context ?? {};
                        const returnErrorData: IDataObject = {
                            error: error.message,
                            statusCode: errorContext.statusCode,
                            headers: errorContext.headers,
                            body: errorContext.body, // Include body from error if available
                        };
						returnData.push({ json: returnErrorData, pairedItem: { item: itemIndex } });
					}
				}

			} catch (error) {
				if (this.continueOnFail(itemIndex)) { // Check continueOnFail per item if necessary
					// Structure the error output consistently
					const errorData: IDataObject = { error: { message: error.message } };
					if (error instanceof NodeApiError && error.context) {
						errorData.error.context = error.context; // Add context from API errors
					}
                    if (error.stack) {
                        errorData.error.stack = error.stack.split('\n').map((line:string) => line.trim());
                    }
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
	 * Static webhook handler. This method needs to be registered with n8n's
	 * webhook routing mechanism to be called when a request hits the node's webhook URL.
	 *
	 * It uses the static listener map to find the correct waiting execution.
	 */
	static async webhook(this: IExecuteFunctions, req: IWebhookRequest): Promise<void> {
        // Extract the unique webhook ID from the request path parameter.
        // N8N provides path parameters in req.params based on the registered route.
        // Assuming the route is registered like '/webhook-wait/:webhookId'
        const webhookUniqueId = req.params?.webhookId as string | undefined;

        if (!webhookUniqueId) {
            console.warn(`Webhook received without a webhookId in path parameters.`);
			// Maybe respond with 400 Bad Request? Depends on n8n's webhook handling.
            return;
        }

		console.debug(`Webhook received for ID: ${webhookUniqueId}`);
        const listenerData = AsyncHttpRequest.webhookListeners.get(webhookUniqueId);

        if (listenerData) {
            const { resolve, reject, timeoutTimer, expectedMethod, correlationId, webhookConfig, nodeInstance, itemIndex } = listenerData;

			// Check HTTP Method
			const receivedMethod = (req.method ?? '').toUpperCase();
			if (receivedMethod !== expectedMethod) {
				console.warn(`Webhook ${webhookUniqueId}: Received method ${receivedMethod}, expected ${expectedMethod}. Ignoring.`);
				// Do not resolve or reject, just ignore this call.
				return;
			}

            try {
				// Extract correlation ID from the incoming webhook request
				const receivedCorrelationId = nodeInstance.handleCorrelationData( // Use nodeInstance to access non-static method
					webhookConfig.correlationIdLocationInWebhook as any,
					webhookConfig.correlationIdParameterNameInWebhook as string,
					req, // Pass the incoming webhook data structure
					undefined, // Not injecting
					true // Indicate it's a webhook request extraction
				) as string | undefined;

                console.debug(`Webhook ${webhookUniqueId}: Expecting CorrelationID ${correlationId}, Received ${receivedCorrelationId}`);

                // Validate correlation ID
                if (receivedCorrelationId === correlationId) {
                    clearTimeout(timeoutTimer); // Stop timeout timer
                    AsyncHttpRequest.webhookListeners.delete(webhookUniqueId); // Remove listener
					console.info(`Webhook ${webhookUniqueId}: Correlation ID match! Resolving promise.`);

                    // Construct response based on user selection
                    const webhookResult: IDataObject = {};
                    const includes = webhookConfig.webhookResponseIncludes || ['body']; // Default to body

                    if (includes.includes('body')) webhookResult.body = req.body;
                    if (includes.includes('headers')) webhookResult.headers = req.headers;
                    if (includes.includes('query')) webhookResult.query = req.query;

                    resolve(webhookResult); // Resolve the waiting promise

                } else {
                    // Correlation ID mismatch - log it but keep listening until timeout
                    console.warn(`Webhook ${webhookUniqueId}: Correlation ID mismatch. Expected ${correlationId}, got ${receivedCorrelationId}. Ignoring webhook call.`);
					// Do not remove listener or clear timeout here.
                }
            } catch (error) {
                // Error during webhook processing (e.g., accessing body path)
                console.error(`Webhook ${webhookUniqueId}: Error processing incoming webhook: ${error.message}`);
				// Decide if this error should reject the promise or just be logged.
				// Rejecting might be appropriate if the error prevents future matches.
				clearTimeout(timeoutTimer);
				AsyncHttpRequest.webhookListeners.delete(webhookUniqueId);
				reject(new NodeOperationError(nodeInstance.getNode(), `Error processing webhook ${webhookUniqueId}: ${error.message}`, { itemIndex }));
            }
        } else {
            // No active listener found for this ID (might be late, duplicate, or wrong ID)
            console.warn(`Webhook received for unknown or inactive listener ID: ${webhookUniqueId}. Ignoring.`);
			// Respond with 404 or 410? Depends on n8n webhook framework capabilities.
			// Example: nodeInstance.webhookRespond(404, 'Webhook ID not found or listener inactive');
        }
    }
}