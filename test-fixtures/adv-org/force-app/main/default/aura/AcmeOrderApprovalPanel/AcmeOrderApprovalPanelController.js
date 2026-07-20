({
    handleApprove: function (component, event, helper) {
        component.set('v.isApproving', true);

        var action = component.get('c.approveOrder');
        action.setParams({
            orderId: component.get('v.recordId')
        });

        action.setCallback(this, function (response) {
            component.set('v.isApproving', false);
            var state = response.getState();

            if (state === 'SUCCESS') {
                var toastEvent = $A.get('e.force:showToast');
                if (toastEvent) {
                    toastEvent.setParams({
                        title: 'Success',
                        message: 'Order approved.',
                        type: 'success'
                    });
                    toastEvent.fire();
                }
            } else if (state === 'ERROR') {
                var errors = response.getError();
                var message = 'Unknown error approving order.';
                if (errors && errors[0] && errors[0].message) {
                    message = errors[0].message;
                }
                var errorToastEvent = $A.get('e.force:showToast');
                if (errorToastEvent) {
                    errorToastEvent.setParams({
                        title: 'Error',
                        message: message,
                        type: 'error'
                    });
                    errorToastEvent.fire();
                }
            }
        });

        $A.enqueueAction(action);
    }
})
