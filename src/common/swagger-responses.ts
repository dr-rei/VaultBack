import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

/**
 * Keep response examples explicit because most handlers return plain objects
 * rather than class-based response DTOs. This makes the generated OpenAPI
 * document useful without changing runtime serialization.
 */
export function ApiExampleResponse(status: number, description: string, example: unknown) {
  return ApiResponse({ status, description, schema: { example } });
}

export function ApiAcceptedExample(description: string, example: unknown) {
  return ApiExampleResponse(202, description, example);
}

export function ApiFileResponse(description: string) {
  return ApiResponse({
    status: 200,
    description,
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
  });
}

export function ApiEventStreamResponse() {
  return ApiResponse({
    status: 200,
    description: 'Authenticated Server-Sent Events stream.',
    content: { 'text/event-stream': { schema: { type: 'string', example: 'event: snapshot\ndata: {"topic":"updates","payload":{}}\n\n' } } }
  });
}

export function ApiCommonErrorResponses() {
  return applyDecorators(
    ApiResponse({ status: 400, description: 'The request is invalid.', schema: { example: { statusCode: 400, error: 'Bad Request', message: 'Validation failed' } } }),
    ApiResponse({ status: 401, description: 'Authentication is required or the session is invalid.', schema: { example: { statusCode: 401, error: 'Unauthorized', message: 'Login required' } } }),
    ApiResponse({ status: 403, description: 'The signed-in user does not have permission.', schema: { example: { statusCode: 403, error: 'Forbidden', message: 'Administrator permission required' } } }),
    ApiResponse({ status: 404, description: 'The requested resource was not found.', schema: { example: { statusCode: 404, error: 'Not Found', message: 'Resource not found' } } })
  );
}
