function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasForbiddenKey(input) {
    if (Array.isArray(input)) {
        return input.some(hasForbiddenKey);
    }

    if (!isPlainObject(input)) {
        return false;
    }

    const keys = Object.keys(input);
    for (const key of keys) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            return true;
        }
        if (hasForbiddenKey(input[key])) {
            return true;
        }
    }

    return false;
}

export function blockPrototypePollution(req, res, next) {
    if (hasForbiddenKey(req.body) || hasForbiddenKey(req.query) || hasForbiddenKey(req.params)) {
        return res.status(400).json({
            success: false,
            requestId: req.requestId,
            message: 'Malformed request payload.',
        });
    }

    return next();
}

export function validateRequest(validator) {
    return (req, res, next) => {
        const message = validator(req);
        if (message) {
            return res.status(400).json({
                success: false,
                requestId: req.requestId,
                message,
            });
        }
        return next();
    };
}

export function validateJsonObjectBody(req) {
    if (req.body == null) return null;
    if (!isPlainObject(req.body)) {
        return 'Request body must be a JSON object.';
    }
    return null;
}

