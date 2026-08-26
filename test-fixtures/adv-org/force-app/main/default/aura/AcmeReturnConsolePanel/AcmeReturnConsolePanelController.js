({
    doInit: function (cmp, event, helper) {
        cmp.set('v.isLoading', true);

        var action = cmp.get('c.getReturnSummary');

        action.setCallback(this, function (response) {
            cmp.set('v.isLoading', false);
            var state = response.getState();

            if (state === 'SUCCESS') {
                cmp.set('v.summary', response.getReturnValue());
            } else if (state === 'ERROR') {
                var errors = response.getError();
                var message = 'Unknown error loading return summary.';
                if (errors && errors[0] && errors[0].message) {
                    message = errors[0].message;
                }
                var evt = $A.get('e.force:showToast');
                if (evt) {
                    evt.setParams({
                        title: 'Error',
                        message: message,
                        type: 'error'
                    });
                    evt.fire();
                }
            }
        });

        $A.enqueueAction(action);
    }
})
