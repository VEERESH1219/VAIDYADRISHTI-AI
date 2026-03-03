export function enforceTenantIsolation(req, res, next) {
    const tenantId = req.tenantId || req.user?.tenantId;
    const userTenantId = req.user?.tenantId;

    if (!tenantId || !userTenantId || tenantId !== userTenantId) {
        return res.status(403).json({
            success: false,
            requestId: req.requestId,
            message: 'Tenant scope validation failed.',
        });
    }

    req.tenantId = userTenantId;
    return next();
}

