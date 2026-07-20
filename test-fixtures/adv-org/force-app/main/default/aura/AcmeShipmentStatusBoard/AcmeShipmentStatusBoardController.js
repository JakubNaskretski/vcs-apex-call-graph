({
    doInit: function (component, event, helper) {
        component.set('v.isLoading', true);

        var action = component.get('c.getShipmentStatuses');

        action.setCallback(this, function (response) {
            component.set('v.isLoading', false);
            var state = response.getState();

            if (state === 'SUCCESS') {
                component.set('v.shipments', response.getReturnValue());
            } else if (state === 'ERROR') {
                var errors = response.getError();
                var message = 'Unknown error loading shipment statuses.';
                if (errors && errors[0] && errors[0].message) {
                    message = errors[0].message;
                }
                var toastEvent = $A.get('e.force:showToast');
                if (toastEvent) {
                    toastEvent.setParams({
                        title: 'Error',
                        message: message,
                        type: 'error'
                    });
                    toastEvent.fire();
                }
            }
        });

        $A.enqueueAction(action);
    }
})
