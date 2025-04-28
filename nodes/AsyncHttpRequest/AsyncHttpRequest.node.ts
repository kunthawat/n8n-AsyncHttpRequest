import {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	INodeExecutionData,
	NodeOperationError,
	IHttpRequestOptions,
	IHttpRequestMethods,
	IDataObject,
	NodeApiError,
	IWebhookFunctions,
	NodeConnectionType, // Keep if specifically used, otherwise remove
	INodeInputConfiguration, // Keep if specifically used, otherwise remove
	INodeOutputConfiguration, // Keep if specifically used, otherwise remove
	IAllExecuteFunctions, // Useful for precise helper 'this' types
	BaseHelperFunctions, // Base types for helpers
	BinaryHelperFunctions, // Types for binary helpers
	RequestHelperFunctions, // Types for request helpers
	NodeExecutionWithMetadata, // Type for getWorkflowStaticData
	Workflow, // Type for getWorkflowStaticData context
	INode, // Base node interface
	NodeParameterValue, // Type for parameter values
	continueOnFail, // Explicit import if needed elsewhere
	IWebhookResponseData, // Type for webhook response if needed
} from 'n8n-workflow';

import { v4 as uuidv4 } from 'uuid';
import * as objectPath from 'object-path'; // Ensure this is installed `npm i object-path @types/object-path`

// --- Interfaces ---

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

interface IWebhookListener {
	resolve: (data: IDataObject) => void;
	reject: (reason?: any) => void;
	timeoutTimer: NodeJS.Timeout;
	expectedMethod: string;
	correlationId: string;
	webhookConfig: IWebhookConfig;
	itemIndex: number;
}

interface IWebhookRequestObject {
	headers: IDataObject;
	params: IDataObject;
	query: IDataObject;
	body: IDataObject | string | unknown; // Body type can be diverse
	method?: string;
	path?: string;
}

// Type guard for NodeApiError
function isNodeApiError(error: any): error is NodeApiError {
	return error instanceof NodeApiError && typeof error.context === 'object';
}

// --- Node Class ---

export class AsyncHttpRequest implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Async HTTP Request',
		name: 'asyncHttpRequest',
		icon: 'fa:exchange-alt',
		group: ['helpers'],
		version: 1,
		description: 'Sends HTTP request, waits for async webhook response.',
		defaults: {
			name: 'Async HTTP Request',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
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
			// --- Standard HTTP Request properties ---
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
					{ name: 'Query Auth', value: 'queryAuth' },
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
					{ name: 'N/A', value: 'none' },
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
					// Corrected displayOptions within options (use absolute path from root)
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
				default: { values: [{ name: '', value: '' }] }, // Default structure for fixed collection
				options: [
					{
						name: 'values',
						displayName: 'Parameter',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
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
			// --- Multipart form-data section ---
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
				default: { values: [{ name: '', value: '', type: 'string' }] }, // Default structure for fixed collection
				description: 'Define the parts of the multipart request. Use expressions for binary data.',
				options: [
					{
						name: 'values',
						displayName: 'Part',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '', description: 'Name of the form field' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '', description: 'Value of the field. For files, use an expression resolving to binary data (e.g., {{$binary.data}}).' },
							{ displayName: 'Type', name: 'type', type: 'options', options: [{ name: 'String', value: 'string' }, { name: 'Binary', value: 'binary' }], default: 'string', description: 'Specify if the value is a string or binary data.' },
							{ displayName: 'Content-Type', name: 'contentType', type: 'string', default: '', description: '(Optional) Specify Content-Type for this part, especially for binary data.' },
							{ displayName: 'Filename', name: 'filename', type: 'string', default: '', description: '(Optional) Specify filename for binary data.' },
						],
					},
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
				default: { values: [{ name: '', value: '' }] }, // Default structure for fixed collection
				options: [
					{
						name: 'values',
						displayName: 'Parameter',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
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
				default: { values: [{ name: '', value: '' }] }, // Default structure for fixed collection
				options: [
					{
						name: 'values',
						displayName: 'Header',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{ displayName: 'Ignore Response Code', name: 'ignoreResponseCode', type: 'boolean', default: false, description: 'Whether to succeed even if the HTTP status code indicates an error' },
					{ displayName: 'Allow Unauthorized Certificates', name: 'allowUnauthorizedCerts', type: 'boolean', default: false, description: 'Whether to allow unauthorized certificates (e.g. self-signed)' },
					{ displayName: 'Timeout (ms)', name: 'timeout', type: 'number', typeOptions: { minValue: 1 }, default: 10000, description: 'Time in milliseconds to wait for the initial request to complete' },
					{ displayName: 'Proxy', name: 'proxy', type: 'string', default: '', placeholder: 'http://myproxy:3128', description: 'HTTP proxy to use for the request (e.g., http://user:pass@host:port)' },
					{ displayName: 'Response Format', name: 'responseFormat', type: 'options', options: [{ name: 'Autodetect', value: 'autodetect' }, { name: 'File', value: 'file' }, { name: 'JSON', value: 'json' }, { name: 'Text', value: 'text' }], default: 'autodetect', description: 'How to format the response data' },
					{ displayName: 'Response Character Encoding', name: 'responseCharacterEncoding', type: 'options', displayOptions: { show: { responseFormat: ['text', 'json', 'autodetect'] } }, options: [{ name: 'Autodetect', value: 'autodetect' }, { name: 'ISO-8859-1', value: 'latin1' }, { name: 'UTF-8', value: 'utf8' }], default: 'autodetect', description: 'Character encoding for text based response formats like JSON and Text.' },
					{ displayName: 'Full Response', name: 'fullResponse', type: 'boolean', default: false, description: 'Whether to return the full response object (including headers, status code) instead of just the body' },
				],
			},
			// --- Webhook Response properties ---
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
					{ displayName: 'Webhook Method', name: 'webhookMethod', type: 'options', options: [{ name: 'POST', value: 'POST' }, { name: 'GET', value: 'GET' }, { name: 'PUT', value: 'PUT' }], default: 'POST', required: true, description: 'The HTTP method the external service will use to call the webhook' },
					{ displayName: 'Correlation ID Location (in Request)', name: 'correlationIdLocationInRequest', type: 'options', options: [{ name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' }, { name: 'Do Not Send', value: 'none' }], default: 'none', description: 'Where to place the unique correlation ID in the initial outbound HTTP request (if needed by the API)' },
					// Corrected displayOptions path syntax (use relative './')
					{ displayName: 'Correlation ID Parameter Name (in Request)', name: 'correlationIdParameterName', type: 'string', default: 'correlationId', required: true, displayOptions: { show: { './correlationIdLocationInRequest': ['query', 'header', 'bodyJsonPath'] } }, description: 'Name of the query parameter, header, or the JSON path (dot notation) for the correlation ID in the initial request' },
					{ displayName: 'Callback URL Parameter Name (in Request)', name: 'callbackUrlParameterNameInRequest', type: 'string', default: 'callbackUrl', required: true, description: 'Parameter name (query, header, or body JSON path) used to send the generated webhook callback URL in the initial request' },
					{ displayName: 'Callback URL Location (in Request)', name: 'callbackUrlLocationInRequest', type: 'options', options: [{ name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' }], default: 'bodyJsonPath', description: 'Where to place the webhook callback URL in the initial outbound HTTP request' },
					{ displayName: 'Correlation ID Location (in Webhook)', name: 'correlationIdLocationInWebhook', type: 'options', options: [{ name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' }], required: true, default: 'bodyJsonPath', description: 'Where to find the correlation ID in the incoming webhook data to match the request' },
					{ displayName: 'Correlation ID Parameter Name (in Webhook)', name: 'correlationIdParameterNameInWebhook', type: 'string', default: 'correlationId', required: true, description: 'Name of the query parameter, header, or the JSON path (dot notation) for the correlation ID in the webhook response' },
					{ displayName: 'Webhook Timeout (seconds)', name: 'timeoutWebhook', type: 'number', typeOptions: { minValue: 1 }, default: 120, description: 'Maximum time (in seconds) to wait for the correct webhook response' },
					{ displayName: 'Webhook Response Includes', name: 'webhookResponseIncludes', type: 'multiOptions', options: [{ name: 'Body', value: 'body' }, { name: 'Headers', value: 'headers' }, { name: 'Query Parameters', value: 'query' }], required: true, default: ['body'], description: 'Which parts of the incoming webhook request to include in the node output' },
				],
			},
		],
		// --- Webhook Registration ---
		webhooks: [
			{
				name: 'default',
				httpMethod: '={{$parameter.webhookConfig.webhookMethod || "POST"}}', // Dynamically set method
				isFullPath: false,
				path: 'webhook/:webhookId', // Path to capture unique ID
				responseCode: '200', // Default success code
			},
		],
		webhookMethods: ['POST', 'GET', 'PUT'], // Explicitly list possible methods
	};


	/**
	 * Handles injecting or extracting correlation data (ID or URL).
	 * @param location Where the data is (query, header, bodyJsonPath, none)
	 * @param paramName Name of parameter/header or JSON path
	 * @param data Request options object (for injection) or Webhook request object (for extraction)
	 * @param valueToSet Value to inject (string), or undefined if extracting
	 * @param isWebhookRequest True if extracting from webhook, false if injecting into request
	 * @param node The INode instance for context
	 * @returns Extracted value (string | undefined) or undefined if injecting/error
	 */
	static handleCorrelationData(
		location: 'query' | 'header' | 'bodyJsonPath' | 'none' | undefined,
		paramName: string,
		data: IHttpRequestOptions | IWebhookRequestObject,
		valueToSet: string | undefined,
		isWebhookRequest: boolean,
		node: INode,
	): string | undefined {
		try {
			if (location === 'none' && !isWebhookRequest) {
				return undefined; // Nothing to inject
			}
			if (!location || !paramName) {
				if (isWebhookRequest && location !== 'none') { // Required for extraction unless 'none' explicitly chosen for injection
				   throw new NodeOperationError(node, `Missing location ('${location}') or parameter name ('${paramName}') for correlation data.`);
				}
				return undefined; // Or not configured for injection
			}

			if (isWebhookRequest) {
				// Extracting from webhook request object
				const req = data as IWebhookRequestObject;
				if (location === 'query') {
					return req.query?.[paramName] as string | undefined;
				} else if (location === 'header') {
					const headerValue = req.headers?.[paramName.toLowerCase()]; // Headers are often lowercased
					return Array.isArray(headerValue) ? headerValue[0] : headerValue as string | undefined;
				} else if (location === 'bodyJsonPath') {
					if (typeof req.body !== 'object' || req.body === null) {
						node.Logger.warn(`Cannot extract correlation ID from body: body is not a parsable object.`);
						return undefined;
					}
					return objectPath.get(req.body, paramName) as string | undefined;
				}
			} else {
				// Injecting into request options object
				const opts = data as IHttpRequestOptions;
				if (location === 'query') {
					opts.qs = opts.qs ?? {};
					opts.qs[paramName] = valueToSet;
				} else if (location === 'header') {
					opts.headers = opts.headers ?? {};
					opts.headers[paramName] = valueToSet;
				} else if (location === 'bodyJsonPath') {
					// Requires body to be JSON object. Needs careful handling.
					// Ensure body exists and is an object before attempting to set path.
					if (typeof opts.body !== 'object' || opts.body === null) {
						// Try parsing if it's a string? Or assume it was prepared as an object?
						// For simplicity, assume opts.body is already the object or needs to be.
						// This might need adjustment based on how body is prepared earlier.
						// If contentType is JSON and specifyBody is keypair, body is built later.
						// If specifyBody is JSON, opts.body is parsed JSON.
						// This logic might need refinement based on the exact state of opts.body
						// when this function is called. Let's assume for now it should be an object.
						if (opts.json && typeof opts.body === 'object' && opts.body !== null) {
							 objectPath.set(opts.body, paramName, valueToSet);
						} else {
							 node.Logger.warn(`Cannot set correlation data in body path '${paramName}': Request body is not setup as a modifiable JSON object at this stage.`);
							 // Consider throwing an error if this is critical
							 // throw new NodeOperationError(node, `Cannot set data in body path '${paramName}': Request body must be JSON object.`);
						}
					} else {
						objectPath.set(opts.body, paramName, valueToSet);
					}
				}
			}
		} catch (error: any) {
			throw new NodeOperationError(node, `Error handling correlation data (${isWebhookRequest ? 'extract' : 'inject'}) at ${location} ('${paramName}'): ${error.message}`);
		}
		return undefined; // Return undefined when injecting
	}


	// --- Execute Method ---
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		// Get global option default once
		const fullResponseGlobal = this.getNodeParameter('options.fullResponse', 0, false) as boolean;

		// Get static data store for webhook listeners
		// Using 'node' scope should isolate listeners per node instance within the workflow execution
		const staticData = this.getWorkflowStaticData('node');
		if (!staticData.listeners) {
			staticData.listeners = {};
		}
		const webhookListeners = staticData.listeners as { [key: string]: IWebhookListener };


		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			// Reset per-item options inside the loop
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
			const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject; // Contains various sub-options
			// Use item-specific value or fallback to global default
			const fullResponse = this.getNodeParameter('options.fullResponse', itemIndex, fullResponseGlobal) as boolean;
			const waitForWebhookResponse = this.getNodeParameter('waitForWebhookResponse', itemIndex, false) as boolean;
			const webhookConfig = this.getNodeParameter('webhookConfig', itemIndex, {}) as IWebhookConfig;

			// Use try-catch for each item to handle potential errors and continueOnFail
			try {
				const requestOptions: IHttpRequestOptions = {
					method,
					uri: url,
					gzip: true,
					rejectUnauthorized: !this.getNodeParameter('options.allowUnauthorizedCerts', itemIndex, false) as boolean,
					timeout: this.getNodeParameter('options.timeout', itemIndex, 10000) as number,
					proxy: this.getNodeParameter('options.proxy', itemIndex, undefined) as string | undefined,
					headers: {},
					qs: {},
					responseType: 'arraybuffer', // Default to buffer, adjust later
					// Request helpers generally handle full response internally, don't need resolveWithFullResponse here
				};

				// --- Response Format & Encoding ---
				const responseFormat = this.getNodeParameter('options.responseFormat', itemIndex, 'autodetect') as string;
				const responseCharacterEncoding = this.getNodeParameter('options.responseCharacterEncoding', itemIndex, 'autodetect') as string;

				if (responseFormat === 'json') requestOptions.responseType = 'json';
				else if (responseFormat === 'text') requestOptions.responseType = 'text';
				// else remains 'arraybuffer' for file/autodetect

				if (requestOptions.responseType === 'text' && responseCharacterEncoding !== 'autodetect') {
					requestOptions.encoding = responseCharacterEncoding as BufferEncoding;
				}
				// Note: encoding for JSON is usually handled by the library, default UTF8


				// --- Headers ---
				if (sendHeaders) {
					const headerValues = this.getNodeParameter('headerParameters.values', itemIndex, []) as Array<{ name?: string, value?: string }>;
					requestOptions.headers = headerValues.reduce((acc, param) => {
						if (param.name) acc[param.name] = param.value ?? '';
						return acc;
					}, requestOptions.headers as IDataObject);
				}

				// --- Query Parameters ---
				if (sendQuery) {
					const queryValues = this.getNodeParameter('queryParameters.values', itemIndex, []) as Array<{ name?: string, value?: string }>;
					requestOptions.qs = queryValues.reduce((acc, param) => {
						if (param.name) acc[param.name] = param.value ?? '';
						return acc;
					}, requestOptions.qs as IDataObject);
				}

				// --- Body ---
				let bodyData: any = undefined; // Define bodyData outside the if block
				if (sendBody && ['POST', 'PATCH', 'PUT'].includes(method)) {
					requestOptions.headers = requestOptions.headers ?? {}; // Ensure headers exist

					if (contentType === 'json') {
						requestOptions.headers['content-type'] = 'application/json; charset=utf-8';
						if (specifyBody === 'keypair') {
							const bodyParams = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{ name?: string, value?: any }>;
							bodyData = bodyParams.reduce((acc, param) => {
								if (param.name) acc[param.name] = param.value;
								return acc;
							}, {} as IDataObject);
						} else if (specifyBody === 'json') {
							const jsonBodyStr = this.getNodeParameter('jsonBody', itemIndex, '{}') as string;
							try { bodyData = JSON.parse(jsonBodyStr); }
							catch (e: any) { throw new NodeOperationError(this.getNode(), `Invalid JSON in body: ${e.message}`, { itemIndex }); }
						}
						requestOptions.json = true; // Use json flag for library
						requestOptions.body = bodyData; // Assign prepared body

					} else if (contentType === 'form-urlencoded') {
						requestOptions.headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
						if (specifyBody === 'keypair') {
							const bodyParams = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{ name?: string, value?: string }>;
							const params = new URLSearchParams();
							bodyParams.forEach(param => { if (param.name) params.append(param.name, param.value ?? ''); });
							bodyData = params.toString();
							requestOptions.body = bodyData;
							requestOptions.json = false; // Explicitly not JSON
						} else {
							throw new NodeOperationError(this.getNode(), 'For form-urlencoded, use "Using Fields Below".', { itemIndex });
						}

					} else if (contentType === 'multipart-form-data') {
						if (sendMultipart) {
							const multipartParams = this.getNodeParameter('multipartParameters.values', itemIndex, []) as Array<{ name?: string, value?: any, type?: string, contentType?: string, filename?: string }>;
							const formData: IDataObject = {};
							for (const part of multipartParams) {
								if (!part.name) continue;
								let value = part.value;
								if (part.type === 'binary') {
									const binaryData = await this.helpers.assertBinaryData(itemIndex, value); // Use await
									const partOptions: { contentType?: string, filename?: string } = {};
									if (part.contentType) partOptions.contentType = part.contentType;
									const filename = part.filename || binaryData.fileName;
									if (filename) partOptions.filename = filename;
									if (binaryData.mimeType && !partOptions.contentType) partOptions.contentType = binaryData.mimeType;

									value = { value: Buffer.from(binaryData.data, 'base64'), options: partOptions };
								}
								formData[part.name] = value;
							}
							requestOptions.formData = formData; // Assign formData object
							delete requestOptions.headers['content-type']; // Let library set multipart header
							requestOptions.json = false;
						} else {
							throw new NodeOperationError(this.getNode(), 'For multipart/form-data, enable "Send Form-Data".', { itemIndex });
						}

					} else if (contentType === 'raw') {
						requestOptions.headers['content-type'] = rawContentType;
						bodyData = this.getNodeParameter('rawBody', itemIndex, '') as string;
						requestOptions.body = bodyData;
						requestOptions.json = false;

					} else if (contentType === 'none') {
						delete requestOptions.headers['content-type'];
						// Do not set body/json properties
					}
					// Assign the prepared bodyData (if any) if not already assigned (e.g. for json/form)
                    // if (bodyData !== undefined && requestOptions.body === undefined) {
                    //     requestOptions.body = bodyData;
                    // }
				} // End of sendBody block


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
						// Other webhookConfig properties are used in the webhook handler
					} = webhookConfig;

					// 1. Get Webhook URL
					// Use the specific webhook name 'default' defined in description
					const webhookUrl = this.getWebhookUrl('default');
                    if (!webhookUrl) {
                         throw new NodeOperationError(this.getNode(), 'Could not generate webhook URL. Is Instance Base URL configured in n8n?', { itemIndex });
                    }
                    // Append the unique ID to the path manually IF getWebhookUrl doesn't handle :webhookId replacement
                    // Check n8n version behavior. Assuming it needs manual appending for now:
                    const finalWebhookUrl = `${webhookUrl}/webhook/${webhookUniqueId}`;


					// 2. Inject Correlation ID (if needed)
					AsyncHttpRequest.handleCorrelationData(
						correlationIdLocationInRequest,
						correlationIdParameterName as string,
						requestOptions, // Pass options object
						correlationIdValue,
						false, // isWebhookRequest = false
						this.getNode(),
					);

					// 3. Inject Callback URL
					AsyncHttpRequest.handleCorrelationData(
						callbackUrlLocationInRequest,
						callbackUrlParameterNameInRequest as string,
						requestOptions, // Pass options object
						finalWebhookUrl, // Pass the constructed URL
						false, // isWebhookRequest = false
						this.getNode(),
					);

					// 4. Setup Waiter Promise & Listener
					const waitPromise = new Promise<IDataObject>((resolve, reject) => {
						const timeoutSeconds = (timeoutWebhook as number) * 1000;
						const timer = setTimeout(() => {
							const listener = webhookListeners[webhookUniqueId]; // Check before accessing
							if (listener) {
								const listenerItemIndex = listener.itemIndex;
								delete webhookListeners[webhookUniqueId]; // Clean up listener
								this.logger.warn(`Webhook ${webhookUniqueId} timed out after ${timeoutWebhook} seconds.`);
								reject(new NodeOperationError(this.getNode(), `Webhook wait timed out for ID ${webhookUniqueId}`, { itemIndex: listenerItemIndex }));
							}
						}, timeoutSeconds);

						// Store listener data correctly
						webhookListeners[webhookUniqueId] = {
							resolve: resolve,
							reject: reject,
							timeoutTimer: timer,
							expectedMethod: (webhookMethod as string).toUpperCase(),
							correlationId: correlationIdValue,
							webhookConfig: webhookConfig, // Store the config for the webhook handler
							itemIndex: itemIndex, // Store itemIndex for error reporting
						};
						this.logger.debug(`Webhook Listener Added: ${webhookUniqueId} for Correlation ID: ${correlationIdValue}`);
					});

					// 5. Send Initial Request
					try {
						this.logger.debug(`Sending initial request [${itemIndex}] for ${webhookUniqueId} (Correlation: ${correlationIdValue})`);
						// Use the correct 'this' context for helpers
						const initialResponse = await (this.helpers as RequestHelperFunctions).requestWithAuthentication(
							authentication,
							requestOptions,
							itemIndex,
						);
						// Log success, but response is ignored unless needed for debugging
						this.logger.debug(`Initial request [${itemIndex}] sent for ${webhookUniqueId}. Status: ${initialResponse?.statusCode}. Waiting for webhook...`);
					} catch (error: any) {
						// Clean up listener if initial request fails critically
						const listenerData = webhookListeners[webhookUniqueId];
						if (listenerData) {
							clearTimeout(listenerData.timeoutTimer);
							delete webhookListeners[webhookUniqueId];
							this.logger.debug(`Webhook Listener Removed due to initial request error: ${webhookUniqueId}`);
						}

						// Re-throw unless ignoring response code AND it's a NodeApiError
						if (!this.getNodeParameter('options.ignoreResponseCode', itemIndex, false) || !isNodeApiError(error)) {
							throw error;
						} else {
							// Log ignored error and proceed to wait for webhook
							this.logger.warn(`Initial request [${itemIndex}] failed but ignoring response code. Error: ${error.message}. Status: ${error.context?.statusCode}. Proceeding to wait for webhook ${webhookUniqueId}.`);
						}
					}

					// 6. Wait for Webhook Promise
					this.logger.debug(`Waiting for webhook ${webhookUniqueId}...`);
					const webhookResult = await waitPromise; // Awaits resolution from webhook handler

					// 7. Add webhook result to output
					returnData.push({ json: webhookResult, pairedItem: { item: itemIndex } });

				} else {
					// --- Standard HTTP Request (No Webhook Wait) ---
					let response: NodeExecutionWithMetadata; // Contains full response object from helper
					try {
						response = await (this.helpers as RequestHelperFunctions).requestWithAuthentication(
							authentication,
							requestOptions,
							itemIndex,
						);

						let responseData: any; // Final data to be put in json property
						let binaryPropertyName: string | undefined = undefined; // For binary output

						const responseBody = response.body; // Could be Buffer, string, object
						const isBuffer = Buffer.isBuffer(responseBody);

						// Handle formatting based on user choice OR full response
						if (!fullResponse) {
							if (responseFormat === 'file') {
								if (!isBuffer) throw new NodeOperationError(this.getNode(), 'Response body is not binary, cannot format as file.', { itemIndex });
								const mimeType = response.headers?.['content-type']?.split(';')[0] || 'application/octet-stream';
								const binaryData = await (this.helpers as BinaryHelperFunctions).prepareBinaryData(responseBody, undefined, mimeType); // Use await
								binaryPropertyName = 'data'; // Standard n8n binary property name
								returnData.push({ json: {}, binary: { [binaryPropertyName]: binaryData }, pairedItem: { item: itemIndex } });
								continue; // Skip standard return push

							} else if (responseFormat === 'text') {
								responseData = isBuffer ? responseBody.toString(requestOptions.encoding || undefined) : String(responseBody);
							} else if (responseFormat === 'json') {
								if (typeof responseBody === 'object' && !isBuffer) {
									responseData = responseBody; // Already parsed by helper
								} else {
									const textBody = isBuffer ? responseBody.toString(requestOptions.encoding || 'utf8') : String(responseBody);
									try { responseData = JSON.parse(textBody); }
									catch (e: any) { throw new NodeOperationError(this.getNode(), `Response body not valid JSON: ${e.message}`, { itemIndex }); }
								}
							} else { // Autodetect
								if (typeof responseBody === 'object' && !isBuffer) {
									responseData = responseBody; // Assume JSON if object
								} else {
									// Try decoding as text, maybe attempt JSON parse?
									responseData = isBuffer ? responseBody.toString(requestOptions.encoding || 'utf8') : String(responseBody);
									// Optional: If content-type suggests JSON, try parsing
                                    // if (response.headers?.['content-type']?.includes('json')) {
                                    //     try { responseData = JSON.parse(responseData); } catch(e) { /* Ignore if parse fails */ }
                                    // }
								}
							}
						} else { // Full Response requested
							let processedBody = responseBody;
							if (isBuffer) {
                                // Provide info about buffer instead of raw data for full response JSON
                                const bufferInfo = `Buffer data (length: ${responseBody.length}, type: ${response.headers?.['content-type']})`;
                                // You could include base64 snippet if needed: responseBody.toString('base64').substring(0, 100)
								processedBody = bufferInfo;
							}
							responseData = {
								headers: response.headers,
								statusCode: response.statusCode,
								statusMessage: response.statusMessage,
								body: processedBody, // Include the potentially processed body
							};
						}

						// Add the result (unless binary was already handled)
						if (binaryPropertyName === undefined) {
							returnData.push({ json: responseData, pairedItem: { item: itemIndex } });
						}

					} catch (error: any) {
						// Handle errors, especially ignored ones
						if (!this.getNodeParameter('options.ignoreResponseCode', itemIndex, false) || !isNodeApiError(error)) {
							throw error; // Re-throw if not ignoring or not standard API error
						}

						// Format ignored error for output
						const errorContext = error.context ?? {};
						const errorOutput = {
							error: {
								message: error.message,
								stack: typeof error.stack === 'string' ? error.stack.split('\n').map((l: string) => l.trim()) : undefined,
								httpCode: errorContext.statusCode,
								httpMessage: errorContext.statusMessage,
								headers: errorContext.headers,
								body: errorContext.body, // Body might be included in error context
							},
						};
						returnData.push({ json: errorOutput, pairedItem: { item: itemIndex } });
					}
				} // End of standard request block

			} catch (error: any) {
				// Handle errors for the item loop (respect continueOnFail)
				if (this.continueOnFail()) {
					const errorJson: IDataObject = { error: { message: error.message } };
					if (error.stack && typeof error.stack === 'string') errorJson.error.stack = error.stack.split('\n').map((l: string) => l.trim());
					if (error instanceof NodeOperationError && error.context) errorJson.error.context = error.context;
					else if (isNodeApiError(error) && error.context) errorJson.error.context = error.context;

					returnData.push({ json: errorJson, pairedItem: { item: itemIndex } });
					continue; // Continue to next item
				}
				// If not continuing, re-throw the error
				throw error;
			}
		} // End of item loop

		return [returnData]; // Return data wrapped in array
	}


	// --- Webhook Method ---
	// 'this' context is IWebhookFunctions
	static async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> { // Use IWebhookResponseData for return type flexibility
		const req = this.getRequestObject() as IWebhookRequestObject; // Cast for convenience
		const node = this.getNode(); // Get node context

		// Extract unique ID from path parameter (defined as ':webhookId' in description)
		const webhookUniqueId = req.params?.webhookId as string | undefined;

		if (!webhookUniqueId) {
			this.logger.warn(`Webhook received without 'webhookId' in path parameters.`);
			// Signal error to n8n core to send appropriate response (e.g., 400)
			throw new NodeOperationError(node, 'Missing webhook identifier in URL path.');
		}

		this.logger.debug(`Webhook received for ID: ${webhookUniqueId}`);

		// Retrieve listeners from static data
		const staticData = this.getWorkflowStaticData('node');
		const webhookListeners = staticData.listeners as { [key: string]: IWebhookListener } || {};
		const listenerData = webhookListeners[webhookUniqueId];

		if (!listenerData) {
			this.logger.warn(`Webhook received for unknown or timed-out listener ID: ${webhookUniqueId}. Ignoring.`);
			// Throw an error to signal failure (e.g., n8n sends 404 or 500)
            // Returning empty object might lead to default 200 OK, which is wrong.
			throw new NodeOperationError(node, `Webhook listener not found or timed out for ID: ${webhookUniqueId}`);
            // return {}; // Avoid returning empty object which implies success
		}

		// Destructure listener data
		const { resolve, reject, timeoutTimer, expectedMethod, correlationId, webhookConfig, itemIndex } = listenerData;

		// Check HTTP Method
		const receivedMethod = (req.method ?? '').toUpperCase();
		if (receivedMethod !== expectedMethod) {
			this.logger.warn(`Webhook ${webhookUniqueId}: Method mismatch. Received ${receivedMethod}, expected ${expectedMethod}. Ignoring.`);
			// Throw error to signal method not allowed (n8n might send 405)
            throw new NodeOperationError(node, `Incorrect HTTP method ${receivedMethod} used for webhook ${webhookUniqueId}. Expected ${expectedMethod}.`, { itemIndex });
            // return {}; // Avoid implying success
		}

		try {
			// Extract Correlation ID from incoming webhook
			const receivedCorrelationId = AsyncHttpRequest.handleCorrelationData(
				webhookConfig.correlationIdLocationInWebhook,
				webhookConfig.correlationIdParameterNameInWebhook as string,
				req, // Pass webhook request object
				undefined, // Not setting a value
				true, // isWebhookRequest = true
				node,
			) as string | undefined;

			this.logger.debug(`Webhook ${webhookUniqueId}: Expecting Correlation ID: ${correlationId}, Received: ${receivedCorrelationId}`);

			// Validate Correlation ID
			if (receivedCorrelationId === correlationId) {
				clearTimeout(timeoutTimer); // Stop timeout timer
				delete webhookListeners[webhookUniqueId]; // Clean up listener
				this.logger.info(`Webhook ${webhookUniqueId}: Correlation ID match! Resolving promise.`);

				// Construct response data based on config
				const webhookResult: IDataObject = {};
				const includes = Array.isArray(webhookConfig.webhookResponseIncludes) ? webhookConfig.webhookResponseIncludes : ['body'];
				if (includes.includes('body')) webhookResult.body = req.body;
				if (includes.includes('headers')) webhookResult.headers = req.headers;
				if (includes.includes('query')) webhookResult.query = req.query;

				resolve(webhookResult); // Resolve the waiting execute promise

				// Signal success to n8n core (sends 200 OK by default based on webhook definition)
				return { noWebhookResponse: false }; // Explicitly allow webhook response

			} else {
				// Correlation ID mismatch - log and ignore, keep listener active
				this.logger.warn(`Webhook ${webhookUniqueId}: Correlation ID mismatch. Expected ${correlationId}, got ${receivedCorrelationId}. Ignoring call.`);
				// Let n8n send the default response (200 OK), but don't resolve/reject promise
                // We throw an error here to signal the mismatch more clearly than a silent 200 OK
                throw new NodeOperationError(node, `Correlation ID mismatch for webhook ${webhookUniqueId}.`, { itemIndex });
                // return { noWebhookResponse: false }; // Still allow default response
			}
		} catch (error: any) {
			// Error during webhook processing (e.g., extracting ID)
			this.logger.error(`Webhook ${webhookUniqueId}: Error processing webhook: ${error.message}`, { error: error.stack });

			// Clean up listener and reject the promise
			clearTimeout(timeoutTimer);
			delete webhookListeners[webhookUniqueId];
			reject(new NodeOperationError(node, `Error processing webhook ${webhookUniqueId}: ${error.message}`, { itemIndex }));

			// Re-throw the error so n8n core sends an error response (e.g., 500)
			throw error;
            // return {}; // Avoid implying success
		}
	} // End of webhook method
} // End of class AsyncHttpRequest
